import ExpoModulesCore
import MediaPlayer

/// Next and previous track, and the scrubber, from the lock screen, Control Center, headphones, and
/// CarPlay.
///
/// expo-audio offers next and previous only for its playlist player, and it switches both commands
/// off each time it puts a player on the lock screen or takes one off. It removes only the targets
/// it added, so this module's targets stay; while JavaScript listens, it switches the commands back
/// on as soon as anything turns them off, and forwards each press as an event.
///
/// expo-audio moves the player itself for a scrub, and switches the scrubber on only while a song
/// of known length plays. This module leaves that as it is and forwards the position too, so the
/// app's player hears the person's seek as it hears a tap.
public final class RemoteCommandsModule: Module {
  private lazy var next = TrackCommand(MPRemoteCommandCenter.shared().nextTrackCommand) { [weak self] in
    self?.sendEvent("nextTrack")
  }

  private lazy var previous = TrackCommand(MPRemoteCommandCenter.shared().previousTrackCommand) { [weak self] in
    self?.sendEvent("previousTrack")
  }

  private lazy var seek = PositionCommand(MPRemoteCommandCenter.shared().changePlaybackPositionCommand) { [weak self] positionMs in
    self?.sendEvent("seekTo", ["positionMs": positionMs])
  }

  public func definition() -> ModuleDefinition {
    Name("RemoteCommands")

    Events("nextTrack", "previousTrack", "seekTo")

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

    OnDestroy {
      self.next.detach()
      self.previous.detach()
      self.seek.detach()
    }
  }
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

/// The scrubber's command, from `attach` until `detach`, forwarding each position in milliseconds.
/// It never switches the command on or off: expo-audio does, by whether the song's length is known.
/// Main thread only, as MPRemoteCommandCenter and expo-audio's MediaController expect.
private final class PositionCommand {
  private let command: MPChangePlaybackPositionCommand
  private let onSeek: (Double) -> Void
  private var target: Any?

  init(_ command: MPChangePlaybackPositionCommand, onSeek: @escaping (Double) -> Void) {
    self.command = command
    self.onSeek = onSeek
  }

  func attach() {
    DispatchQueue.main.async { [self] in
      guard target == nil else {
        return
      }

      target = command.addTarget { [onSeek] event in
        guard let change = event as? MPChangePlaybackPositionCommandEvent else {
          return .commandFailed
        }

        onSeek(change.positionTime * 1000)
        return .success
      }
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
