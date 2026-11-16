import AVFoundation
import AVKit
import ExpoModulesCore

/// Where the app's sound goes, and the system's AirPlay route picker (ADR 0018).
///
/// `output` answers the current route: an AirPlay receiver by its name, or this phone's own
/// outputs (its speaker, headphones, a car). `outputChanged` sends the same answer each time the
/// route changes while JavaScript listens. The `AudioRoute` view is the system's route picker,
/// `AVRoutePickerView`: tapping it opens the picker, and the app's audio plays where it was until
/// the person chooses a route there.
public final class AudioRouteModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("AudioRoute")

    Events("outputChanged")

    Function("output") { () -> [String: Any?] in
      currentOutput()
    }

    OnStartObserving {
      DispatchQueue.main.async { [self] in
        guard observer == nil else {
          return
        }

        observer = NotificationCenter.default.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: AVAudioSession.sharedInstance(),
          queue: .main
        ) { [weak self] _ in
          self?.sendEvent("outputChanged", currentOutput())
        }
      }
    }

    OnStopObserving {
      DispatchQueue.main.async { [self] in
        if let attached = observer {
          NotificationCenter.default.removeObserver(attached)
          observer = nil
        }
      }
    }

    View(AudioRoutePickerView.self) {
      Prop("tint") { (view: AudioRoutePickerView, tint: UIColor?) in
        view.picker.tintColor = tint
      }

      Prop("activeTint") { (view: AudioRoutePickerView, tint: UIColor?) in
        view.picker.activeTintColor = tint
      }

      Events("onBeginPresentingRoutes", "onEndPresentingRoutes")
    }
  }
}

/// The current route as JavaScript reads it: `airplay` with the receiver's name when an AirPlay
/// output is in it, else `local`. A receiver without a visible name answers null.
private func currentOutput() -> [String: Any?] {
  let outputs = AVAudioSession.sharedInstance().currentRoute.outputs

  guard let airplay = outputs.first(where: { $0.portType == .airPlay }) else {
    return ["kind": "local", "receiver": nil]
  }

  let name = airplay.portName.trimmingCharacters(in: .whitespacesAndNewlines)

  return ["kind": "airplay", "receiver": name.isEmpty ? nil : name]
}

/// The system's route picker, filling the view, which tells JavaScript as it opens and closes.
final class AudioRoutePickerView: ExpoView, AVRoutePickerViewDelegate {
  let picker = AVRoutePickerView()
  let onBeginPresentingRoutes = EventDispatcher()
  let onEndPresentingRoutes = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    picker.delegate = self
    picker.prioritizesVideoDevices = false
    addSubview(picker)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picker.frame = bounds
  }

  func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    onBeginPresentingRoutes()
  }

  func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    onEndPresentingRoutes()
  }
}
