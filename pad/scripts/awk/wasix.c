/*
 * The pad's awk on WASIX: four things its libc does not do as awk needs,
 * linked in ahead of libc's own.
 *
 * popen() and pclose(). The sysroot's popen starts its shell with
 * posix_spawn, whose child faults in execve ("out of bounds memory access",
 * in combine_strings — Wasmer's CLI, 20 October 2026), while fork and exec
 * work, there and in the browser. So these are popen and
 * pclose by fork, dup2 and exec, as POSIX describes them: the child closes
 * the pipes of every stream opened before, so a `print | "sort"` still open
 * does not keep another's input from ending. Being defined here, libc's are
 * never linked.
 *
 * writev(), which all of stdio writes through. A real awk writing to a pipe
 * nobody reads any more is killed by SIGPIPE, without a word; here the write
 * fails with EPIPE, and awk would say "write error on /dev/stdout" after
 * every `awk … | head -1`. So EPIPE ends it as the signal would, status 141.
 *
 * The working directory. libc resolves a relative path against a directory
 * of its own, "/" until chdir() sets it, rather than the one the process was
 * started in, so `awk 1 file` could not find ./file. It is set from the
 * runtime's at start.
 *
 * main(). awk names itself by argv[0] in what it says ("awk: syntax error"),
 * and here argv[0] is the path of the .wasm; awk's main is compiled as
 * awk_main and called with its proper name.
 */
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wasi/api.h>

struct child {
	FILE *f;
	pid_t pid;
	struct child *next;
};
static struct child *children;

FILE *popen(const char *cmd, const char *mode)
{
	int reading, p[2], mine, theirs, want;
	struct child *c, *o;
	pid_t pid;

	if (mode == NULL || (mode[0] != 'r' && mode[0] != 'w')) {
		errno = EINVAL;
		return NULL;
	}
	reading = mode[0] == 'r';
	if ((c = malloc(sizeof *c)) == NULL)
		return NULL;
	if (pipe(p) < 0) {
		free(c);
		return NULL;
	}
	mine = reading ? p[0] : p[1];
	theirs = reading ? p[1] : p[0];
	want = reading ? 1 : 0;
	if ((pid = fork()) < 0) {
		int e = errno;
		close(p[0]);
		close(p[1]);
		free(c);
		errno = e;
		return NULL;
	}
	if (pid == 0) {
		for (o = children; o != NULL; o = o->next)
			close(fileno(o->f));
		close(mine);
		if (theirs != want) {
			dup2(theirs, want);
			close(theirs);
		}
		execl("/bin/sh", "sh", "-c", cmd, (char *) NULL);
		_exit(127);
	}
	close(theirs);
	if ((c->f = fdopen(mine, reading ? "r" : "w")) == NULL) {
		int e = errno;
		close(mine);
		while (waitpid(pid, NULL, 0) < 0 && errno == EINTR)
			;
		free(c);
		errno = e;
		return NULL;
	}
	c->pid = pid;
	c->next = children;
	children = c;
	return c->f;
}

int pclose(FILE *f)
{
	struct child **at, *c;
	int status;
	pid_t pid;

	for (at = &children; *at != NULL && (*at)->f != f; at = &(*at)->next)
		;
	if ((c = *at) == NULL) {
		errno = ECHILD;
		return -1;
	}
	*at = c->next;
	pid = c->pid;
	free(c);
	fclose(f);
	while (waitpid(pid, &status, 0) < 0)
		if (errno != EINTR)
			return -1;
	return status;
}

ssize_t writev(int fd, const struct iovec *iov, int iovcnt)
{
	__wasi_size_t written;
	__wasi_errno_t e;

	if (iovcnt < 0) {
		errno = EINVAL;
		return -1;
	}
	e = __wasi_fd_write(fd, (const __wasi_ciovec_t *) iov, iovcnt, &written);
	if (e == __WASI_ERRNO_PIPE)
		_exit(128 + 13);	/* SIGPIPE's */
	if (e != 0) {
		errno = e;
		return -1;
	}
	return written;
}

int awk_main(int argc, char *argv[]);

int main(int argc, char *argv[])
{
	static char name[] = "awk";
	char cwd[PATH_MAX];

	if (getcwd(cwd, sizeof cwd) != NULL)
		chdir(cwd);
	if (argc > 0)
		argv[0] = name;
	return awk_main(argc, argv);
}
