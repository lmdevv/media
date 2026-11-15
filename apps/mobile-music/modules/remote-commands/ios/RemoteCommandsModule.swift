import AVFoundation
import ExpoModulesCore
import MediaPlayer

/// The system's playback commands, from the lock screen, Control Center, headphones, and CarPlay.
///
/// expo-audio offers next and previous only for its playlist player, and it switches both commands
/// off each time it puts a player on the lock screen or takes one off. It removes only the targets
/// it added, so this module's targets stay; while JavaScript listens, it switches the commands back
/// on as soon as anything turns them off, and forwards each press as an event.
///
/// expo-audio plays and pauses the AVPlayer on the lock screen itself for play, pause, and the
/// play/pause toggle, moves it for a scrub, and pauses every player when headphones are unplugged.
/// It tells JavaScript only of the player's new state, and a song that stops at its end looks the
/// same. This module leaves all of that as it is. It forwards each play, pause, and toggle as a
/// play or a pause, decided here as the press comes and tagged with the player it acted on, which
/// the app names with `follow`, so the app's player hears the person's choice itself, as it hears a
/// tap. It forwards the unplug too. It switches none of these commands on or off: expo-audio does,
/// by whether a song is on the lock screen and whether its length is known.
public final class RemoteCommandsModule: Module {
  /// The player on the lock screen, as the app last named it. Main thread only.
  private var shown: Shown?

  private lazy var next = TrackCommand(MPRemoteCommandCenter.shared().nextTrackCommand) { [weak self] in
    self?.sendEvent("nextTrack")
  }

  private lazy var previous = TrackCommand(MPRemoteCommandCenter.shared().previousTrackCommand) { [weak self] in
    self?.sendEvent("previousTrack")
  }

  private lazy var seek = CommandTarget(MPRemoteCommandCenter.shared().changePlaybackPositionCommand) { [weak self] event in
    guard let change = event as? MPChangePlaybackPositionCommandEvent else {
      return .commandFailed
    }

    self?.sendEvent("seekTo", ["positionMs": change.positionTime * 1000])
    return .success
  }

  private lazy var play = CommandTarget(MPRemoteCommandCenter.shared().playCommand) { [weak self] _ in
    self?.forward(.play)
    return .success
  }

  private lazy var pause = CommandTarget(MPRemoteCommandCenter.shared().pauseCommand) { [weak self] _ in
    self?.forward(.pause)
    return .success
  }

  private lazy var toggle = CommandTarget(MPRemoteCommandCenter.shared().togglePlayPauseCommand) { [weak self] _ in
    self?.forward(.toggle)
    return .success
  }

  private lazy var unplugged = OutputGone { [weak self] in
    self?.sendEvent("unplugged")
  }

  public func definition() -> ModuleDefinition {
    Name("RemoteCommands")

    Events("nextTrack", "previousTrack", "seekTo", "play", "pause", "unplugged")

    Function("follow") { (player: SharedRef<AVPlayer>, id: String) in
      DispatchQueue.main.async {
        self.shown = Shown(player: player, id: id)
      }
    }

    Function("unfollow") { (id: String) in
      DispatchQueue.main.async {
        if self.shown?.id == id {
          self.shown = nil
        }
      }
    }

    OnStartObserving("nextTrack") {
      self.next.attach()
    }

    OnStopObserving("nextTrack") {
      self.next.detach()
    }

    OnStartObserving("previousTrack") {
      self.previous.attach()
    }

    OnStopObserving("previousTrack") {
      self.previous.detach()
    }

    OnStartObserving("seekTo") {
      self.seek.attach()
    }

    OnStopObserving("seekTo") {
      self.seek.detach()
    }

    // A toggle sends a play or a pause, and the app listens to both together.
    OnStartObserving("play") {
      self.play.attach()
      self.toggle.attach()
    }

    OnStopObserving("play") {
      self.play.detach()
      self.toggle.detach()
    }

    OnStartObserving("pause") {
      self.pause.attach()
    }

    OnStopObserving("pause") {
      self.pause.detach()
    }

    OnStartObserving("unplugged") {
      self.unplugged.attach()
    }

    OnStopObserving("unplugged") {
      self.unplugged.detach()
    }

    OnDestroy {
      self.next.detach()
      self.previous.detach()
      self.seek.detach()
      self.play.detach()
      self.pause.detach()
      self.toggle.detach()
      self.unplugged.detach()
    }
  }

  /// Sends `press` as a play or a pause on the main queue's next turn, with the id of the player
  /// that was on the lock screen as it came, or none. The command center calls every target of a
  /// press in that one turn, in no documented order, so by the next one expo-audio's own target has
  /// played or paused that player, and a toggle sends what it did.
  private func forward(_ press: Press) {
    let pressed = shown
    let player = pressed?.player?.ref

    DispatchQueue.main.async { [weak self] in
      let plays: Bool

      switch press {
      case .play:
        plays = true
      case .pause:
        plays = false
      case .toggle:
        guard let player else {
          return
        }

        plays = player.timeControlStatus != .paused
      }

      self?.sendEvent(plays ? "play" : "pause", ["player": pressed?.id])
    }
  }
}

/// What a press asks of the player on the lock screen.
private enum Press {
  case play
  case pause
  case toggle
}

/// The lock screen's player, held weakly so a released one goes, and the app's id for it.
private struct Shown {
  weak var player: SharedRef<AVPlayer>?
  let id: String
}

/// One remote command this module holds on, from `attach` until `detach`. Main thread only, as
/// MPRemoteCommandCenter and expo-audio's MediaController expect.
private final class TrackCommand {
  private let command: MPRemoteCommand
  private let onPress: () -> Void
  private var target: Any?
  private var enabledObservation: NSKeyValueObservation?

  init(_ command: MPRemoteCommand, onPress: @escaping () -> Void) {
    self.command = command
    self.onPress = onPress
  }

  func attach() {
    DispatchQueue.main.async { [self] in
      guard target == nil else {
        return
      }

      target = command.addTarget { [onPress] _ in
        onPress()
        return .success
      }
      enabledObservation = command.observe(\.isEnabled) { command, _ in
        if !command.isEnabled {
          command.isEnabled = true
        }
      }
      command.isEnabled = true
    }
  }

  func detach() {
    DispatchQueue.main.async { [self] in
      guard let attached = target else {
        return
      }

      enabledObservation?.invalidate()
      enabledObservation = nil
      command.removeTarget(attached)
      target = nil
      command.isEnabled = false
    }
  }
}

/// A target this module holds on one remote command, from `attach` until `detach`, beside
/// expo-audio's own. It never switches the command on or off: expo-audio does, by whether a song is
/// on the lock screen and whether its length is known. Main thread only, as MPRemoteCommandCenter
/// and expo-audio's MediaController expect.
private final class CommandTarget {
  private let command: MPRemoteCommand
  private let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus
  private var target: Any?

  init(_ command: MPRemoteCommand, handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
    self.command = command
    self.handler = handler
  }

  func attach() {
    DispatchQueue.main.async { [self] in
      guard target == nil else {
        return
      }

      target = command.addTarget(handler: handler)
    }
  }

  func detach() {
    DispatchQueue.main.async { [self] in
      guard let attached = target else {
        return
      }

      command.removeTarget(attached)
      target = nil
    }
  }
}

/// The audio output going away, as headphones unplugged or a car disconnected, from `attach` until
/// `detach`. iOS stops the audio then, and expo-audio pauses every player.
private final class OutputGone {
  private let onGone: () -> Void
  private var observer: NSObjectProtocol?

  init(onGone: @escaping () -> Void) {
    self.onGone = onGone
  }

  func attach() {
    DispatchQueue.main.async { [self] in
      guard observer == nil else {
        return
      }

      observer = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: AVAudioSession.sharedInstance(),
        queue: .main
      ) { [onGone] notification in
        guard
          let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: reason) == .oldDeviceUnavailable
        else {
          return
        }

        onGone()
      }
    }
  }

  func detach() {
    DispatchQueue.main.async { [self] in
      guard let attached = observer else {
        return
      }

      NotificationCenter.default.removeObserver(attached)
      observer = nil
    }
  }
}
