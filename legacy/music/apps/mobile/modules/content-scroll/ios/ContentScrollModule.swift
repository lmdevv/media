import ExpoModulesCore
import UIKit

/// A view that names the scroll view inside it as its page's content scroll view.
///
/// iOS minimizes the tab bar and moves the mini player inline as the selected tab's content
/// scrolls, and finds that content by guessing from the view hierarchy. The guess finds a page
/// whose scroll view is the screen's root, but misses most pushed pages (a list under a floating
/// bar, an artist's hero), so their scrolling leaves the tab bar as it is. This view tells UIKit
/// instead: once it is on screen it sets the first scroll view inside it as the content scroll
/// view of its page's controller and of the containers above it, up to the tab bar controller.
/// A page shown again, such as one uncovered by Back, sets it again.
public final class ContentScrollModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ContentScroll")

    View(ContentScrollView.self) {}
  }
}

final class ContentScrollView: ExpoView {
  private static let edges: NSDirectionalRectEdge = [.top, .bottom]

  /// The scroll view this view last set, and the controllers it set it on.
  private weak var registered: UIScrollView?
  private var controllers: [WeakController] = []

  override func didMoveToWindow() {
    super.didMoveToWindow()

    if window == nil {
      unregister()
    } else {
      register()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // React mounts the list after this view, and a list can swap its scroll view; both lay out.
    if window != nil, firstScrollView(in: self) !== registered {
      register()
    }
  }

  private func register() {
    // A scroll view that went away leaves nothing for UIKit to watch.
    guard let scrollView = firstScrollView(in: self) else {
      unregister()
      return
    }

    unregister()
    registered = scrollView

    var controller = owningController()
    while let current = controller, !(current is UITabBarController) {
      current.setContentScrollView(scrollView, for: Self.edges)
      controllers.append(WeakController(current))
      controller = current.parent
    }
  }

  /// Clears what this view set, unless another page has set its own since.
  private func unregister() {
    for weak in controllers {
      guard let controller = weak.controller else { continue }

      if controller.contentScrollView(for: .bottom) === registered {
        controller.setContentScrollView(nil, for: Self.edges)
      }
    }
    controllers = []
    registered = nil
  }

  private func owningController() -> UIViewController? {
    var responder: UIResponder? = next

    while let current = responder {
      if let controller = current as? UIViewController {
        return controller
      }
      responder = current.next
    }

    return nil
  }

  /// The first scroll view under `view`, breadth first, so a list beats the rails inside it.
  private func firstScrollView(in view: UIView) -> UIScrollView? {
    var queue = view.subviews[...]

    while let candidate = queue.popFirst() {
      if let scrollView = candidate as? UIScrollView {
        return scrollView
      }
      queue.append(contentsOf: candidate.subviews)
    }

    return nil
  }
}

private struct WeakController {
  weak var controller: UIViewController?

  init(_ controller: UIViewController) {
    self.controller = controller
  }
}
