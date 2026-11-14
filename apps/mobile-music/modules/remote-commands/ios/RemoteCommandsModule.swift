import ExpoModulesCore
import MediaPlayer

/// Next and previous track from the lock screen, Control Center, headphones, and CarPlay.
///
/// expo-audio offers these only for its playlist player, and it switches both commands off each
/// time it puts a player on the lock screen or takes one off. It removes only the targets it added,
/// so this module's targets stay; while JavaScript listens, it switches the commands back on as
/// soon as anything turns them off, and forwards each press as an event.
public final class RemoteCommandsModule: Module {
  private lazy var next = TrackCommand(MPRemoteCommandCenter.shared().nextTrackCommand) { [weak self] in
    self?.sendEvent("nextTrack")
  }

  private lazy var previous = TrackCommand(MPRemoteCommandCenter.shared().previousTrackCommand) { [weak self] in
    self?.sendEvent("previousTrack")
  }

  public func definition() -> ModuleDefinition {
    Name("RemoteCommands")

    Events("nextTrack", "previousTrack")

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

    OnDestroy {
      self.next.detach()
      self.previous.detach()
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
