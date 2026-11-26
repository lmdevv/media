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
/// - `FrameMark` is an empty view that reports, once, the display refresh that first shows it: in
///   the window, inside the window's bounds as it moves on screen, and covered by no opaque view,
///   such as the splash screen over React Native's root view. It reports the refresh's target time,
///   when the frame committed before it is due on screen, and whether the refresh is hitched: the
///   mark's callbacks skipped a refresh before it, or this callback ran past its target, so the app
///   was busy across a refresh and the frame may show a refresh or more after its target. iOS gives
///   no time at which an ordinary frame was really shown. Each mark also goes to the device's log
///   under its `name`, with the gap since its previous callback and how far past the target this
///   one ran, as numbers only.
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
      Events("onDrawn")

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

/// A view whose layers, multiplied up to the window, are nearly transparent shows nothing.
private let shownOpacity: Float = 0.01

/// A covering view's background must be this opaque to hide what is under it.
private let coveringAlpha: CGFloat = 0.99

/// A callback that runs this many refresh intervals past its refresh's target ran late: the frame
/// it would commit misses that refresh.
private let lateCallback: CFTimeInterval = 0.25

/// Two callbacks this many intervals apart, or more, had at least one refresh between them that the
/// app was too busy to take.
private let missedRefresh: CFTimeInterval = 1.5

/// Where each mark goes in the device's log, for a probe to read the app's own clock.
private let markLog = Logger(subsystem: "dev.lmdevv.launch-clock", category: "frame-mark")

final class FrameMarkView: ExpoView {
  let onDrawn = EventDispatcher()

  /// What the mark marks, such as `home-content`; it names the mark in the device's log.
  var name = ""

  private var link: CADisplayLink?
  private var deadline: CFTimeInterval = 0
  /// When the refresh of the mark's previous callback began; none before its first callback.
  private var previousRefresh: CFTimeInterval?
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
    previousRefresh = nil
    let link = CADisplayLink(target: WeakTarget(self), selector: #selector(WeakTarget.tick(_:)))
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  private func stop() {
    link?.invalidate()
    link = nil
  }

  /// Runs once per display refresh, ahead of its target. Whatever the app committed before it is
  /// what the render server draws for the refresh at `targetTimestamp`, unless the app was busy
  /// across a refresh: then the refresh is hitched.
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

    guard isShown() else { return }

    reported = true
    stop()
    let at = link.targetTimestamp * 1000
    markLog.notice(
      "\(self.name, privacy: .public) drawn at \(at, format: .fixed(precision: 3), privacy: .public) hitched \(hitched, privacy: .public) gap \(gap * 1000, format: .fixed(precision: 3), privacy: .public) past \(pastTarget * 1000, format: .fixed(precision: 3), privacy: .public)"
    )
    onDrawn(["at": at, "hitched": hitched])
  }

  /// Whether the render server has this view on screen: every layer up to the window rendered and
  /// visible, part of it inside the window's bounds where the animations have it now, and no later
  /// sibling of it or of a view above it covering that part with an opaque background.
  private func isShown() -> Bool {
    guard let window, !window.isHidden,
      let presented = layer.presentation(),
      let windowPresented = window.layer.presentation()
    else {
      return false
    }

    var opacity: Float = 1
    var view: UIView? = self
    while let current = view {
      opacity *= current.layer.presentation()?.opacity ?? 0
      if current.isHidden || opacity < shownOpacity {
        return false
      }
      view = current.superview
    }

    let onScreen = presented.convert(presented.bounds, to: windowPresented)
      .intersection(windowPresented.bounds)

    guard !onScreen.isNull, onScreen.width >= 1, onScreen.height >= 1 else {
      return false
    }

    return !isCovered(onScreen, in: windowPresented)
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

  private func covers(_ view: UIView, _ area: CGRect, in windowPresented: CALayer) -> Bool {
    guard !view.isHidden,
      let presented = view.layer.presentation(),
      presented.opacity >= Float(coveringAlpha),
      let alpha = view.backgroundColor?.cgColor.alpha ?? view.layer.backgroundColor?.alpha
    else {
      return false
    }

    return alpha >= coveringAlpha
      && presented.convert(presented.bounds, to: windowPresented).contains(area)
  }
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
