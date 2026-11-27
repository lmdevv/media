import Darwin
import ExpoModulesCore
import QuartzCore
import UIKit
import os

/// The clock and frame marks that time launches and screen opens (`@media/mobile-core/app-events`).
///
/// Every time it answers is milliseconds on `CACurrentMediaTime`, the monotonic clock that iOS
/// stamps touches (`UITouch.timestamp`, React Native's `nativeEvent.timestamp`) and display
/// refreshes with. It never steps, and stops while the device sleeps.
///
/// - `processStartedAt` answers when this process started, or null when the kernel does not say
///   or iOS prewarmed the process: a prewarmed process starts before anyone opens the app, so its
///   start says nothing about how long the launch took.
/// - `FrameMark` is an empty view laid over the content a person waits for. It reports, once, two
///   display refreshes: the first after the commit that mounted it and its content is laid out
///   (ready), wherever the content stands then, and the first that shows the content as it will
///   rest (at rest): where its layout puts it, so a screen sliding in has arrived, with the part
///   the window shows inside the window's bounds; faded in to its resting opacity; covered by no
///   view that shows over all of it, such as the splash screen over React Native's root view; and
///   with no animation still bringing it in. Each is the refresh's target time, with whether it is
///   hitched: the mark's callbacks skipped a refresh before it, or this callback ran past its
///   target, so the app was busy across a refresh and the frame may show a refresh or more after
///   its time. iOS gives no time at which an ordinary frame was really shown. Each mark also goes
///   to the device's log under its `name`, with when it entered the window, the gap since its
///   previous callback, and how far past the target the last one ran, as numbers only.
public final class LaunchClockModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LaunchClock")

    Function("processStartedAt") { () -> Double? in
      processStartedAt()
    }

    Function("now") { () -> Double in
      CACurrentMediaTime() * 1000
    }

    View(FrameMarkView.self) {
      Events("onMarked")

      Prop("name") { (view: FrameMarkView, name: String) in
        view.name = name
      }
    }
  }
}

/// The kernel records a process's start on the wall clock; this moves it to the monotonic clock by
/// the two clocks' difference now. A wall clock step between the start and this call moves it too.
private func processStartedAt() -> Double? {
  if ProcessInfo.processInfo.environment["ActivePrewarm"] == "1" {
    return nil
  }

  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]

  guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0 else {
    return nil
  }

  let start = info.kp_proc.p_un.__p_starttime
  let startedOnWall = Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
  let wallNow = Date().timeIntervalSince1970 * 1000
  let monotonicNow = CACurrentMediaTime() * 1000

  return monotonicNow - (wallNow - startedOnWall)
}

/// How long a mark waits to be shown before it stops looking.
private let markPatience: CFTimeInterval = 60

/// A view whose layers, multiplied up to the window, are nearly transparent shows nothing; a
/// covering view this transparent hides nothing.
private let shownOpacity: Float = 0.01

/// A callback that runs this many refresh intervals past its refresh's target ran late: the frame
/// it would commit misses that refresh.
private let lateCallback: CFTimeInterval = 0.25

/// Two callbacks this many intervals apart, or more, had at least one refresh between them that the
/// app was too busy to take.
private let missedRefresh: CFTimeInterval = 1.5

/// Where each mark goes in the device's log, for a probe to read the app's own clock.
private let markLog = Logger(subsystem: "dev.lmdevv.launch-clock", category: "frame-mark")

final class FrameMarkView: ExpoView {
  let onMarked = EventDispatcher()

  /// What the mark marks, such as `home-content`; it names the mark in the device's log.
  var name = ""

  private var link: CADisplayLink?
  private var deadline: CFTimeInterval = 0
  /// When the refresh of the mark's previous callback began; none before its first callback.
  private var previousRefresh: CFTimeInterval?
  /// When the mark last entered a window: the commit that mounted its content reached the screen's
  /// layer tree.
  private var mountedAt: CFTimeInterval = 0
  /// The first refresh after the mark's content was committed and laid out, and whether it was
  /// hitched; none before it.
  private var ready: (at: CFTimeInterval, hitched: Bool)?
  private var reported = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()

    if window == nil || reported {
      stop()
    } else {
      start()
    }
  }

  deinit {
    link?.invalidate()
  }

  private func start() {
    guard link == nil else { return }

    deadline = CACurrentMediaTime() + markPatience
    mountedAt = CACurrentMediaTime()
    previousRefresh = nil
    ready = nil
    let link = CADisplayLink(target: WeakTarget(self), selector: #selector(WeakTarget.tick(_:)))
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  private func stop() {
    link?.invalidate()
    link = nil
  }

  /// Runs once per display refresh, ahead of its target. What the app's layer tree holds now,
  /// its commits and the animations it has finished and removed, is what the render server draws
  /// for the refresh at `targetTimestamp`, unless the app was busy across a refresh: then the
  /// refresh is hitched. The first refresh at which the mark is in a window with its layout done
  /// is its content's ready refresh, wherever the content stands; the first at which it is at rest
  /// ends the mark.
  fileprivate func tick(_ link: CADisplayLink) {
    let interval = link.targetTimestamp - link.timestamp
    let gap = previousRefresh.map { link.timestamp - $0 } ?? 0
    let pastTarget = CACurrentMediaTime() - link.targetTimestamp
    let hitched = gap >= missedRefresh * interval || pastTarget >= lateCallback * interval
    previousRefresh = link.timestamp

    if link.timestamp > deadline {
      stop()
      return
    }

    if ready == nil, window != nil, !bounds.isEmpty {
      ready = (link.targetTimestamp, hitched)
    }

    guard let ready, sight() == .atRest else { return }

    reported = true
    stop()
    let readyAt = ready.at * 1000
    let at = link.targetTimestamp * 1000
    markLog.notice(
      "\(self.name, privacy: .public) ready at \(readyAt, format: .fixed(precision: 3), privacy: .public) hitched \(ready.hitched, privacy: .public) rests at \(at, format: .fixed(precision: 3), privacy: .public) hitched \(hitched, privacy: .public) mounted \(self.mountedAt * 1000, format: .fixed(precision: 3), privacy: .public) gap \(gap * 1000, format: .fixed(precision: 3), privacy: .public) past \(pastTarget * 1000, format: .fixed(precision: 3), privacy: .public)"
    )
    onMarked([
      "ready": ["at": readyAt, "hitched": ready.hitched],
      "atRest": ["at": at, "hitched": hitched],
    ])
  }

  /// What the render server shows of this view. Each layer has two states: its model, where
  /// layout puts it, and its presentation, where the running animations have it on screen now. The
  /// view is in sight when every layer up to the window is rendered and visible, part of its
  /// rectangle is inside the window's bounds, and no later sibling of it or of a view above it
  /// shows over all of that part. It is at rest once no animation runs on it or any layer it hangs
  /// from, it stands where its layout puts it, within a pixel, and as opaque as at rest, and its
  /// rectangle lies wholly inside the window, within half a pixel, or across the whole window on an
  /// axis where it is longer, as content taller than the screen is: so a transition that slides,
  /// scales, or fades it in has ended, even one that moves the layout itself. Until then it is
  /// arriving.
  private func sight() -> Sight {
    guard let window, !window.isHidden,
      let presented = layer.presentation(),
      let windowPresented = window.layer.presentation()
    else {
      return .hidden
    }

    var opacityNow: Float = 1
    var opacityAtRest: Float = 1
    var animated = false
    var view: UIView? = self
    while let current = view {
      if current.isHidden {
        return .hidden
      }
      opacityNow *= current.layer.presentation()?.opacity ?? 0
      opacityAtRest *= current.layer.opacity
      animated = animated || !(current.layer.animationKeys() ?? []).isEmpty
      view = current.superview
    }

    let now = presented.convert(presented.bounds, to: windowPresented)
    let onScreen = now.intersection(windowPresented.bounds)

    guard opacityNow >= shownOpacity, !onScreen.isNull, onScreen.width >= 1, onScreen.height >= 1,
      !isCovered(onScreen, in: windowPresented)
    else {
      return .hidden
    }

    let atRest = layer.convert(layer.bounds, to: window.layer)
    let pixel = 1 / max(window.screen.scale, 1)
    let inPlace =
      abs(now.minX - atRest.minX) <= pixel && abs(now.minY - atRest.minY) <= pixel
      && abs(now.width - atRest.width) <= pixel && abs(now.height - atRest.height) <= pixel
    let inside =
      fits(now.minX, now.maxX, in: windowPresented.bounds.minX, windowPresented.bounds.maxX, pixel / 2)
      && fits(now.minY, now.maxY, in: windowPresented.bounds.minY, windowPresented.bounds.maxY, pixel / 2)

    return !animated && inPlace && inside && opacityNow >= opacityAtRest - shownOpacity
      ? .atRest : .arriving
  }

  /// Whether a span from `low` to `high` lies inside the window's span, within `slack`: wholly,
  /// or, for a span longer than the window's, across all of it, as content taller than the
  /// screen does.
  private func fits(
    _ low: CGFloat, _ high: CGFloat, in windowLow: CGFloat, _ windowHigh: CGFloat, _ slack: CGFloat
  ) -> Bool {
    high - low <= windowHigh - windowLow + slack
      ? low >= windowLow - slack && high <= windowHigh + slack
      : low <= windowLow + slack && high >= windowHigh - slack
  }

  private func isCovered(_ area: CGRect, in windowPresented: CALayer) -> Bool {
    var child: UIView = self

    while let parent = child.superview {
      if let index = parent.subviews.firstIndex(of: child) {
        for sibling in parent.subviews[(index + 1)...] where covers(sibling, area, in: windowPresented) {
          return true
        }
      }
      child = parent
    }

    return false
  }

  /// Whether `view` shows a background over all of `area`, however faintly.
  private func covers(_ view: UIView, _ area: CGRect, in windowPresented: CALayer) -> Bool {
    guard !view.isHidden,
      let presented = view.layer.presentation(),
      let alpha = view.backgroundColor?.cgColor.alpha ?? view.layer.backgroundColor?.alpha
    else {
      return false
    }

    return presented.opacity * Float(alpha) >= shownOpacity
      && presented.convert(presented.bounds, to: windowPresented).contains(area)
  }
}

/// What a frame mark's callback saw of it: not in sight, in sight on its way in, or at rest.
private enum Sight {
  case hidden
  case arriving
  case atRest
}

/// Holds the mark weakly, since a display link retains its target.
private final class WeakTarget: NSObject {
  private weak var mark: FrameMarkView?

  init(_ mark: FrameMarkView) {
    self.mark = mark
    super.init()
  }

  @objc func tick(_ link: CADisplayLink) {
    guard let mark else {
      link.invalidate()
      return
    }
    mark.tick(link)
  }
}
