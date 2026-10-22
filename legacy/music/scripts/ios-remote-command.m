// Sends a media remote command (what a lock screen, Control Center, or AirPods press sends) to
// the simulator's now-playing app, so remote commands can be checked without a hand on the
// simulator. Built and run by `scripts/ios-mac.sh remote`. MediaRemote is private; this is a dev
// tool and never ships in the app.
#import <Foundation/Foundation.h>
#include <dlfcn.h>

typedef Boolean (*SendCommand)(int command, NSDictionary *options);

static const struct {
  const char *name;
  int value;
} commands[] = {
    {"play", 0}, {"pause", 1}, {"toggle", 2}, {"next", 4}, {"previous", 5},
};

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 2) {
      fprintf(stderr, "usage: ios-remote-command play|pause|toggle|next|previous\n");
      return 2;
    }

    int command = -1;
    for (size_t i = 0; i < sizeof commands / sizeof commands[0]; i++) {
      if (strcmp(argv[1], commands[i].name) == 0) command = commands[i].value;
    }
    if (command < 0) {
      fprintf(stderr, "unknown command %s\n", argv[1]);
      return 2;
    }

    void *mediaRemote =
        dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
    SendCommand send = mediaRemote ? (SendCommand)dlsym(mediaRemote, "MRMediaRemoteSendCommand") : NULL;
    if (!send) {
      fprintf(stderr, "MRMediaRemoteSendCommand is unavailable: %s\n", dlerror());
      return 1;
    }

    Boolean sent = send(command, nil);
    printf("sent %s: %s\n", argv[1], sent ? "yes" : "no");
    // The command goes out over XPC; keep the process alive until it has.
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:1.0]];
    return sent ? 0 : 1;
  }
}
