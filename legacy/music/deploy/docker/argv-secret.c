/*
 * argv-secret: an LD_PRELOAD shim that keeps a secret off a process's command line.
 *
 * convex-local-backend and generate_key take the Convex instance secret only as an argument, and
 * any process in the container, including the unprivileged media service, can read every other
 * process's arguments in /proc/<pid>/cmdline. Run them with
 *
 *   LD_PRELOAD=/app/convex/argv-secret.so ARGV_SECRET_FILE=<path> program ... @ARGV_SECRET_FILE
 *
 * Before the program's initializers and main run, this points every argument that is exactly
 * "@ARGV_SECRET_FILE" at the first line of that file. The program parses the secret, while
 * /proc/<pid>/cmdline, which shows the original argument strings, still shows the placeholder.
 * Nothing secret lands in /proc/<pid>/environ either: only the file's path does.
 *
 * It fails closed. When the placeholder is present and the file is unset, unreadable, or empty,
 * the process exits before main, so it never starts with the placeholder as its secret.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static const char placeholder[] = "@ARGV_SECRET_FILE";

static void fail(const char *message) {
  fprintf(stderr, "argv-secret: %s\n", message);
  _exit(111);
}

static char *read_secret(void) {
  const char *path = getenv("ARGV_SECRET_FILE");

  if (path == NULL || path[0] == '\0') fail("ARGV_SECRET_FILE is not set");

  FILE *file = fopen(path, "r");

  if (file == NULL) fail("cannot open ARGV_SECRET_FILE");

  char *line = NULL;
  size_t capacity = 0;
  ssize_t length = getline(&line, &capacity, file);

  fclose(file);

  while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) {
    line[--length] = '\0';
  }

  if (length <= 0) fail("ARGV_SECRET_FILE is empty");

  return line;
}

/* glibc passes argc, argv, and envp to the initializers of preloaded objects, which run before
 * the program's own. The argv array is the one the program reads its arguments from. */
__attribute__((constructor)) static void replace_placeholder(int argc, char **argv, char **envp) {
  (void)envp;
  char *secret = NULL;

  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], placeholder) != 0) continue;
    if (secret == NULL) secret = read_secret();
    argv[index] = secret;
  }

  /* Child processes need neither the shim nor the path. */
  unsetenv("ARGV_SECRET_FILE");
  unsetenv("LD_PRELOAD");
}
