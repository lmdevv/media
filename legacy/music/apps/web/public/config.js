// Runtime configuration, loaded before the app. It is empty by default, and the container image
// serves it as is: the app then talks to /convex on its own origin, which Caddy proxies. To point
// a web build hosted elsewhere at a server, set its Convex URL here:
// window["__MUSIC_CONFIG__"] = { convexUrl: "https://music.example.com/convex" };
window["__MUSIC_CONFIG__"] = null;
