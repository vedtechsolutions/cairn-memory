/*
 * hook-relay — fast compiled relay for Cairn hook daemon.
 *
 * Reads JSON from stdin, POSTs to the daemon unix socket at
 * ~/.cairn/hook-daemon.sock, prints the response body to stdout.
 *
 * Fallback behavior (GAP A): when the socket is missing, unreachable,
 * or connect fails, we `execvp("node", ...)` the matching direct-node
 * hook script and let it process stdin in-place. This makes every
 * relay-routed hook resilient to MCP server restart / crash / cold-boot
 * race instead of silently no-opping.
 *
 * Script layout expected (dist/ layout in practice):
 *   <binary_dir>/<hook-type>.js
 *
 * Usage: hook-relay <hook-type>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <libgen.h>
#include <limits.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <signal.h>
#include <sys/time.h>

#define SOCK_PATH_TEMPLATE "%s/.cairn/hook-daemon.sock"
#define CAIRN_MAX_INPUT  (256 * 1024)  /* 256 KB max stdin */
#define CAIRN_MAX_RESP   (64 * 1024)   /* 64 KB max response */
#define TIMEOUT_MS 3000
#define GOVERNANCE_TIMEOUT_MS 400

/* Sentinel exit codes for the fallback child, so the parent can log WHY the
 * hook never ran while still exiting 0 itself (stdout must stay clean for
 * Claude Code). 127 mirrors the shell command-not-found convention. A hook
 * script legitimately exiting 126/127 produces at worst a spurious log line. */
#define FALLBACK_EXIT_SETUP_FAIL 126   /* dup2/stdin wiring failed pre-exec */
#define FALLBACK_EXIT_EXEC_FAIL  127   /* execvp("node", ...) failed */

static char input_buf[CAIRN_MAX_INPUT];
static char resp_buf[CAIRN_MAX_RESP];
static char hdr_buf[512];

static void governance_watchdog(int signal_number) {
    (void)signal_number;
    _exit(0);
}

/* Effective timeout in ms, overridable via env. Correctness tests exercise
 * response handling, not the production SLA, so they must not race a
 * wall-clock deadline against a CPU-starved mock socket under full-suite load.
 * Falls back to the compiled default on a missing or malformed value. */
static long env_timeout_ms(const char *name, long fallback) {
    const char *value = getenv(name);
    if (value == NULL || value[0] == '\0') return fallback;
    char *end = NULL;
    long parsed = strtol(value, &end, 10);
    if (end != value && *end == '\0' && parsed > 0 && parsed <= 600000) return parsed;
    return fallback;
}

static int valid_governance_body(const char *body, size_t body_len) {
    const char *prefix = "{\"systemMessage\":\"";
    size_t prefix_len = strlen(prefix);
    size_t start = 0, end = body_len;
    while (start < end && (body[start] == ' ' || body[start] == '\n' || body[start] == '\r' || body[start] == '\t')) start++;
    while (end > start && (body[end - 1] == ' ' || body[end - 1] == '\n' || body[end - 1] == '\r' || body[end - 1] == '\t')) end--;
    if (start == end) return 1;
    if (end - start < prefix_len + 2 || memcmp(body + start, prefix, prefix_len) != 0 ||
        body[end - 2] != '\"' || body[end - 1] != '}') return 0;
    for (size_t i = start + prefix_len; i < end - 2; i++) {
        unsigned char current = (unsigned char)body[i];
        if (current < 0x20 || current == '\"') return 0;
        if (current != '\\') continue;
        if (++i >= end - 2) return 0;
        char escaped = body[i];
        if (strchr("\"\\/bfnrt", escaped)) continue;
        if (escaped != 'u' || i + 4 >= end - 2) return 0;
        for (int hex = 0; hex < 4; hex++) {
            char digit = body[++i];
            if (!((digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f') ||
                  (digit >= 'A' && digit <= 'F'))) return 0;
        }
    }
    return 1;
}

/* Write exactly len bytes to fd, retrying partial writes. 0 on success. */
static int send_all(int fd, const char *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t w = write(fd, buf + sent, len - sent);
        if (w <= 0) return -1;
        sent += (size_t)w;
    }
    return 0;
}

/*
 * Diagnostic: append one line to ~/.cairn/hook-relay-fallback.log each
 * time we take the fallback path, tagged with the reason. Non-fatal —
 * any failure to open/write is silently ignored. Preserves errno across
 * the call so subsequent logic can still use it.
 */
static void log_fallback(const char *home, const char *hook_type, const char *reason) {
    if (!home || !hook_type || !reason) return;

    int saved_errno = errno;

    char log_path[PATH_MAX];
    int n = snprintf(log_path, sizeof(log_path), "%s/.cairn/hook-relay-fallback.log", home);
    if (n <= 0 || (size_t)n >= sizeof(log_path)) { errno = saved_errno; return; }

    int fd = open(log_path, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (fd < 0) { errno = saved_errno; return; }

    time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);

    char line[512];
    int m = snprintf(line, sizeof(line),
        "%04d-%02d-%02dT%02d:%02d:%02dZ pid=%d hook=%s reason=%s errno=%s\n",
        tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
        tm.tm_hour, tm.tm_min, tm.tm_sec,
        (int)getpid(), hook_type, reason, strerror(saved_errno));
    if (m > 0) {
        /* Truncate rather than drop: a cut-off diagnostic (long script path
         * in the reason) still beats no line at all. */
        size_t to_write = (size_t)m < sizeof(line) ? (size_t)m : sizeof(line) - 1;
        if (to_write == sizeof(line) - 1) line[to_write - 1] = '\n';
        ssize_t w = write(fd, line, to_write);
        (void)w;
    }
    close(fd);
    errno = saved_errno;
}

/*
 * Resolve <dir-of-this-binary>/<hook_type>.js into `out`. Prefers
 * /proc/self/exe (Linux) over argv[0]: sandbox shims and wrappers can
 * rewrite argv[0] (e.g. to a bare basename), which would make dirname()
 * yield "." and resolve the sibling script against an arbitrary cwd.
 * Falls back to argv[0] where /proc is unavailable (macOS). 0 on success.
 */
static int build_script_path(const char *argv0, const char *hook_type,
                             char *out, size_t out_len) {
    char bin_path[PATH_MAX];
    ssize_t r = readlink("/proc/self/exe", bin_path, sizeof(bin_path) - 1);
    if (r > 0) {
        bin_path[r] = '\0';
    } else {
        int m = snprintf(bin_path, sizeof(bin_path), "%s", argv0);
        if (m <= 0 || (size_t)m >= sizeof(bin_path)) return -1;
    }
    const char *dir = dirname(bin_path); /* mutates bin_path copy — fine */
    int n = snprintf(out, out_len, "%s/%s.js", dir, hook_type);
    if (n <= 0 || (size_t)n >= out_len) return -1;
    return 0;
}

/*
 * Fallback path: exec `node <script_dir>/<hook_type>.js`, feeding the
 * buffered stdin back through a pipe so the JS hook reads the same bytes
 * the socket would have received. The script directory comes from
 * build_script_path (/proc/self/exe, argv[0] fallback).
 *
 * stream_stdin_rest: inputs larger than CAIRN_MAX_INPUT can't be buffered
 * whole — when set, the pump relays the unread remainder of our own stdin
 * to the child after the buffered prefix, so oversized hook payloads reach
 * the JS hook intact instead of as truncated (unparseable) JSON.
 *
 * Async vs sync hooks: we exec synchronously in both cases because
 * Claude Code owns the lifecycle — if the hook is registered async in
 * settings.json, Claude Code already runs the command in the background
 * and doesn't wait for stdout. For sync hooks, stdout from the exec'd
 * node process flows back to Claude Code the same way this binary's
 * stdout would.
 *
 * Returns only on exec failure; on success the process is replaced.
 */
static int exec_fallback(const char *argv0, const char *hook_type,
                         const char *input, size_t input_len,
                         int stream_stdin_rest) {
    char script_path[PATH_MAX];
    if (build_script_path(argv0, hook_type, script_path, sizeof(script_path)) != 0) {
        log_fallback(getenv("HOME"), hook_type, "fallback-script-path-fail");
        return -1;
    }

    /* Refuse to exec if the script doesn't exist — keeps behavior safe
     * for unknown hook names (we silent-exit 0 instead of printing a
     * node crash to stdout). Logged with the resolved path + errno so a
     * wrong-directory resolution or unreadable mount is diagnosable. */
    struct stat sb;
    if (stat(script_path, &sb) != 0 || !S_ISREG(sb.st_mode)) {
        char reason[PATH_MAX + 32];
        snprintf(reason, sizeof(reason), "fallback-script-missing:%s", script_path);
        log_fallback(getenv("HOME"), hook_type, reason);
        return -1;
    }

    /* Two explicit pipes: stdin feed and stdout return. The child does NOT
     * rely on inheriting our stdout — some sandboxes mark the launcher's
     * fd 1 close-on-exec (or revoke it across the grandchild's execve), so
     * an exec'd child writes into the void while everything reports success.
     * dup2() onto STDOUT_FILENO in the child also clears CLOEXEC by POSIX
     * semantics, and the parent pumps the output to its own stdout, which
     * it can verifiably write to. */
    int in_pipe[2];
    if (pipe(in_pipe) != 0) {
        log_fallback(getenv("HOME"), hook_type, "fallback-pipe-fail");
        return -1;
    }
    int out_pipe[2];
    if (pipe(out_pipe) != 0) {
        close(in_pipe[0]);
        close(in_pipe[1]);
        log_fallback(getenv("HOME"), hook_type, "fallback-stdout-pipe-fail");
        return -1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        close(in_pipe[0]);
        close(in_pipe[1]);
        close(out_pipe[0]);
        close(out_pipe[1]);
        log_fallback(getenv("HOME"), hook_type, "fallback-fork-fail");
        return -1;
    }

    if (pid == 0) {
        /* Child: wire both ends, exec node. Failures exit silently (no
         * stdout for Claude Code) but with sentinel codes the parent turns
         * into log lines — otherwise a sandbox that denies exec makes the
         * hook vanish with no observable trace at all. */
        close(in_pipe[1]);
        close(out_pipe[0]);
        if (dup2(in_pipe[0], STDIN_FILENO) < 0) _exit(FALLBACK_EXIT_SETUP_FAIL);
        if (dup2(out_pipe[1], STDOUT_FILENO) < 0) _exit(FALLBACK_EXIT_SETUP_FAIL);
        close(in_pipe[0]);
        close(out_pipe[1]);
        /* M3: prefer an explicit absolute node path (CAIRN_NODE, set by the
         * hook config) and execv it directly, so a writable directory
         * prepended to an inherited $PATH cannot substitute a hostile `node`.
         * Falls back to a PATH search only when CAIRN_NODE is unset, matching
         * prior behavior for installs that have not configured it yet. */
        char *args[] = { (char *)"node", script_path, NULL };
        const char *cairn_node = getenv("CAIRN_NODE");
        if (cairn_node != NULL && cairn_node[0] == '/') {
            args[0] = (char *)cairn_node;
            execv(cairn_node, args);
        } else {
            execvp("node", args);
        }
        _exit(FALLBACK_EXIT_EXEC_FAIL);
    }

    /* Parent: poll-multiplex feeding stdin and draining stdout. Sequential
     * write-then-read would deadlock if the child emits more than a pipe
     * buffer of output before finishing its stdin read; polling both ends
     * makes progress whichever direction is ready. No pump timeout: hook
     * lifecycle/timeout is owned by Claude Code, same as before. */
    close(in_pipe[0]);
    close(out_pipe[1]);

    /* Feed state: drain the buffered `input` first; in streaming mode,
     * then relay the unread remainder of our stdin chunk by chunk. Only
     * one source is armed per poll round (pipe POLLOUT while bytes are
     * pending, own-stdin POLLIN while refilling), so a slow child that
     * floods stdout can never deadlock the pump. */
    size_t written = 0;
    char feed_chunk[4096];
    size_t chunk_len = 0, chunk_off = 0;
    int stdin_open = stream_stdin_rest ? 1 : 0;
    int in_open = (input_len > 0 || stdin_open) ? 1 : 0;
    if (!in_open) close(in_pipe[1]);
    int out_open = 1;

    while (in_open || out_open) {
        struct pollfd pfds[2];
        nfds_t nfds = 0;
        int in_idx = -1, src_idx = -1, out_idx = -1;
        int have_pending = (written < input_len) || (chunk_off < chunk_len);
        if (in_open && have_pending) {
            pfds[nfds].fd = in_pipe[1];    pfds[nfds].events = POLLOUT; in_idx = (int)nfds++;
        } else if (in_open) { /* streaming refill: buffered bytes drained */
            pfds[nfds].fd = STDIN_FILENO;  pfds[nfds].events = POLLIN;  src_idx = (int)nfds++;
        }
        if (out_open) { pfds[nfds].fd = out_pipe[0]; pfds[nfds].events = POLLIN;  out_idx = (int)nfds++; }

        int pr = poll(pfds, nfds, -1);
        if (pr < 0) {
            if (errno == EINTR) continue;
            log_fallback(getenv("HOME"), hook_type, "fallback-pump-poll-fail");
            break;
        }

        if (in_idx >= 0 && (pfds[in_idx].revents & (POLLOUT | POLLERR | POLLHUP))) {
            ssize_t w = -1;
            int from_input = (written < input_len);
            if (pfds[in_idx].revents & POLLOUT) {
                w = from_input
                    ? write(in_pipe[1], input + written, input_len - written)
                    : write(in_pipe[1], feed_chunk + chunk_off, chunk_len - chunk_off);
            }
            if (w > 0) {
                if (from_input) written += (size_t)w; else chunk_off += (size_t)w;
            }
            if (w <= 0) {
                /* Child stopped reading (died / never reads) — stop feeding
                 * and let stdout/waitpid tell. */
                close(in_pipe[1]);
                in_open = 0;
            } else if (written >= input_len && chunk_off >= chunk_len && !stdin_open) {
                close(in_pipe[1]);
                in_open = 0;
            }
        }

        if (src_idx >= 0 && (pfds[src_idx].revents & (POLLIN | POLLERR | POLLHUP))) {
            ssize_t r = read(STDIN_FILENO, feed_chunk, sizeof(feed_chunk));
            if (r <= 0) { /* EOF (or unreadable stdin): everything is fed */
                stdin_open = 0;
                close(in_pipe[1]);
                in_open = 0;
            } else {
                chunk_len = (size_t)r;
                chunk_off = 0;
            }
        }

        if (out_idx >= 0 && (pfds[out_idx].revents & (POLLIN | POLLERR | POLLHUP))) {
            char buf[4096];
            ssize_t r = read(out_pipe[0], buf, sizeof(buf));
            if (r <= 0) {
                close(out_pipe[0]);
                out_open = 0;
            } else {
                size_t fwd = 0;
                while (fwd < (size_t)r) {
                    ssize_t w = write(STDOUT_FILENO, buf + fwd, (size_t)r - fwd);
                    if (w <= 0) {
                        log_fallback(getenv("HOME"), hook_type, "fallback-stdout-write-fail");
                        close(out_pipe[0]);
                        out_open = 0;
                        break;
                    }
                    fwd += (size_t)w;
                }
            }
        }
    }
    if (in_open) close(in_pipe[1]);
    if (out_open) close(out_pipe[0]);

    /* Reap the child. Every abnormal outcome is logged — a child that
     * vanishes without trace is undebuggable in sandboxed environments. */
    int status = 0;
    pid_t wr;
    while ((wr = waitpid(pid, &status, 0)) < 0 && errno == EINTR) { /* retry */ }

    if (wr < 0) {
        /* ECHILD: something auto-reaped the child (inherited SIGCHLD=SIG_IGN
         * or a sandbox supervisor) — its fate is unobservable from here. */
        log_fallback(getenv("HOME"), hook_type, "fallback-wait-fail");
    } else if (WIFSIGNALED(status)) {
        /* e.g. SIGSYS(31) = seccomp denied a syscall (likely the execve). */
        char reason[64];
        snprintf(reason, sizeof(reason), "fallback-child-signal-%d", WTERMSIG(status));
        log_fallback(getenv("HOME"), hook_type, reason);
    } else if (WIFEXITED(status) && WEXITSTATUS(status) != 0) {
        int code = WEXITSTATUS(status);
        if (code == FALLBACK_EXIT_EXEC_FAIL) {
            log_fallback(getenv("HOME"), hook_type, "fallback-exec-node-fail");
        } else if (code == FALLBACK_EXIT_SETUP_FAIL) {
            log_fallback(getenv("HOME"), hook_type, "fallback-child-setup-fail");
        } else {
            /* The hook script itself failed (crash, closed stdout, ...). */
            char reason[64];
            snprintf(reason, sizeof(reason), "fallback-child-exit-%d", code);
            log_fallback(getenv("HOME"), hook_type, reason);
        }
    }

    return 0;
}

int main(int argc, char *argv[]) {
    if (argc < 2) return 1;

    /* A daemon that drops the connection mid-write, or a fallback child that
     * dies pre-exec, would otherwise SIGPIPE-kill this process; ignoring it
     * turns those into EPIPE write errors the fallback paths already handle. */
    signal(SIGPIPE, SIG_IGN);

    /* Optional declared client identity: `--client <name> <hook-type>`.
     * Forwarded as an X-Cairn-Client header on the socket path; exported as
     * CAIRN_CLIENT so every exec_fallback child inherits it. The name comes
     * from hook wiring Cairn itself authors, never from the payload. */
    int argi = 1;
    const char *client_name = NULL;
    if (argc >= 4 && strcmp(argv[1], "--client") == 0) {
        client_name = argv[2];
        setenv("CAIRN_CLIENT", client_name, 1);
        argi = 3;
    } else {
        /* Mirror hook-relay.sh: without --client, a stale inherited
         * CAIRN_CLIENT must not leak into fallback children — a Claude
         * session would otherwise emit the codex JSON envelope. */
        unsetenv("CAIRN_CLIENT");
    }

    const char *hook_type = argv[argi];
    /* Self-identification probe: lets `cairn init`/`doctor` confirm this binary
     * actually runs on THIS platform and is the Cairn relay. A shipped
     * wrong-arch/OS ELF execvp-falls-back to /bin/sh and would otherwise look
     * "runnable" (exit 127) — only the real relay prints this sentinel. */
    if (strcmp(hook_type, "--cairn-probe") == 0) {
        const char msg[] = "cairn-relay\n";
        ssize_t written = write(STDOUT_FILENO, msg, sizeof(msg) - 1);
        (void)written;
        return 0;
    }
    int is_governance = strcmp(hook_type, "governance-gate") == 0;
    long governance_timeout_ms = env_timeout_ms("CAIRN_GOVERNANCE_TIMEOUT_MS", GOVERNANCE_TIMEOUT_MS);
    long daemon_timeout_ms = env_timeout_ms("CAIRN_DAEMON_TIMEOUT_MS", TIMEOUT_MS);
    if (is_governance) {
        struct sigaction action;
        memset(&action, 0, sizeof(action));
        action.sa_handler = governance_watchdog;
        sigaction(SIGALRM, &action, NULL);
        struct itimerval timer = {0};
        timer.it_value.tv_sec = governance_timeout_ms / 1000;
        timer.it_value.tv_usec = (governance_timeout_ms % 1000) * 1000;
        setitimer(ITIMER_REAL, &timer, NULL);
    }
    const char *home = getenv("HOME");
    if (!home) return 1;

    /* Build socket path. Sized to match sun_path so strncpy can't truncate. */
    char sock_path[108];
    int sock_n = snprintf(sock_path, sizeof(sock_path), SOCK_PATH_TEMPLATE, home);
    if (sock_n <= 0 || (size_t)sock_n >= sizeof(sock_path)) return 1;

    /* Read stdin up front so both paths (socket and fallback) see the
     * same bytes. We need it for the fallback exec pipe anyway. */
    size_t input_len = 0;
    ssize_t n;
    while (input_len < CAIRN_MAX_INPUT - 1) {
        n = read(STDIN_FILENO, input_buf + input_len, CAIRN_MAX_INPUT - 1 - input_len);
        if (n <= 0) break;
        input_len += n;
    }
    input_buf[input_len] = '\0';

    /* Oversized input: the buffer filled before EOF, so the socket path
     * would advertise a truncated JSON body — a guaranteed parse failure
     * at the daemon AND in a buffered fallback (observed live: a 260 KB
     * PostToolUse payload). Stream the buffered prefix plus the unread
     * remainder of stdin straight to the direct-node hook instead. */
    if (input_len >= CAIRN_MAX_INPUT - 1 && n > 0) {
        log_fallback(home, hook_type, "input-overflow-stream");
        if (!is_governance) exec_fallback(argv[0], hook_type, input_buf, input_len, 1);
        return 0;
    }

    /* Standalone hooks own their own DB access — mirror hook-relay.sh's
     * STANDALONE_HOOKS list and skip the socket round-trip entirely
     * (the daemon has no route for them; going there just logs a
     * bad-status fallback on every fire). */
    if (strcmp(hook_type, "precompact") == 0 || strcmp(hook_type, "session-end") == 0) {
        exec_fallback(argv[0], hook_type, input_buf, input_len, 0);
        return 0;
    }

    /* Check socket exists. If missing, exec the JS fallback directly. */
    struct stat st;
    if (stat(sock_path, &st) != 0 || !S_ISSOCK(st.st_mode)) {
        log_fallback(home, hook_type, "socket-missing");
        if (!is_governance) exec_fallback(argv[0], hook_type, input_buf, input_len, 0);
        return 0;
    }

    /* Build HTTP headers only. The body is written separately from
     * input_buf so a NUL byte in the payload can't truncate it out from
     * under the Content-Length we advertise. */
    char client_hdr[96] = "";
    if (client_name != NULL) {
        int cn = snprintf(client_hdr, sizeof(client_hdr),
                          "X-Cairn-Client: %s\r\n", client_name);
        if (cn <= 0 || (size_t)cn >= sizeof(client_hdr)) client_hdr[0] = '\0';
    }
    int hdr_len = snprintf(hdr_buf, sizeof(hdr_buf),
        "POST /%s HTTP/1.0\r\n"
        "Content-Type: application/json\r\n"
        "%s"
        "Content-Length: %zu\r\n"
        "\r\n",
        hook_type, client_hdr, input_len);
    if (hdr_len <= 0 || (size_t)hdr_len >= sizeof(hdr_buf)) {
        log_fallback(home, hook_type, "header-overflow");
        if (!is_governance) exec_fallback(argv[0], hook_type, input_buf, input_len, 0);
        return 0;
    }

    /* Connect to unix socket */
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        log_fallback(home, hook_type, "socket-syscall-fail");
        if (!is_governance) exec_fallback(argv[0], hook_type, input_buf, input_len, 0);
        return 0;
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    /* sock_path was length-checked above (snprintf return) so this fits. */
    memcpy(addr.sun_path, sock_path, (size_t)sock_n);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        int saved_errno = errno;
        close(fd);
        errno = saved_errno;
        log_fallback(home, hook_type, "connect-fail");
        if (!is_governance) exec_fallback(argv[0], hook_type, input_buf, input_len, 0);
        return 0;
    }

    /* Send request: headers, then raw body bytes. */
    if (send_all(fd, hdr_buf, (size_t)hdr_len) != 0 ||
        send_all(fd, input_buf, input_len) != 0) {
        int saved_errno = errno;
        close(fd);
        errno = saved_errno;
        /* Daemon accepted the connection then dropped it — fall back
         * to direct-node so the hook still runs. */
        log_fallback(home, hook_type, "write-fail");
        if (!is_governance) exec_fallback(argv[0], hook_type, input_buf, input_len, 0);
        return 0;
    }

    /* Read response with timeout */
    size_t resp_len = 0;
    struct pollfd pfd = { .fd = fd, .events = POLLIN };

    while (resp_len < CAIRN_MAX_RESP - 1) {
        int ret = poll(&pfd, 1, (int)(is_governance ? governance_timeout_ms : daemon_timeout_ms));
        if (ret <= 0) break; /* timeout or error */
        n = read(fd, resp_buf + resp_len, CAIRN_MAX_RESP - 1 - resp_len);
        if (n <= 0) break;
        resp_len += n;
    }
    resp_buf[resp_len] = '\0';
    close(fd);
    if (is_governance) {
        struct itimerval timer = {0};
        setitimer(ITIMER_REAL, &timer, NULL);
    }

    /* Require a parsed 2xx status before trusting the body. A 404
     * (hook type with no socket route) or 5xx must fall back to
     * direct-node instead of printing the error body as hook output.
     * An empty/unparseable response (daemon timed out mid-handling)
     * keeps the old silent exit — the daemon may have processed the
     * event, so re-running it could double-process. */
    int status_code = 0;
    if (sscanf(resp_buf, "HTTP/%*d.%*d %d", &status_code) != 1) return 0;
    if (status_code < 200 || status_code >= 300) {
        log_fallback(home, hook_type, "bad-status");
        if (!is_governance) exec_fallback(argv[0], hook_type, input_buf, input_len, 0);
        return 0;
    }

    /* Extract body after \r\n\r\n — length from resp_len, not strlen,
     * so NUL bytes in the response can't truncate hook output. */
    char *body = strstr(resp_buf, "\r\n\r\n");
    if (body) {
        body += 4;
        size_t body_len = resp_len - (size_t)(body - resp_buf);
        if (is_governance && !valid_governance_body(body, body_len)) return 0;
        if (body_len > 0) {
            size_t w_total = 0;
            while (w_total < body_len) {
                ssize_t w = write(STDOUT_FILENO, body + w_total, body_len - w_total);
                if (w <= 0) break;
                w_total += (size_t)w;
            }
        }
    }

    return 0;
}
