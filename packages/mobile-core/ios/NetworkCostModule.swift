import ExpoModulesCore
import Network

/// What the network the phone uses now costs, as iOS rates its path: `expensive` on cellular and on
/// a personal hotspot (a Wi-Fi network iOS knows spends mobile data), `constrained` on a network
/// with Low Data Mode on. expo-network reports only the interface type, which calls a hotspot
/// Wi-Fi and a VPN unknown. The monitor starts at the first read or listener and runs until the
/// module goes.
public final class NetworkCostModule: Module {
  private let queue = DispatchQueue(label: "lar.network-cost")
  private let lock = NSLock()
  private var monitor: NWPathMonitor?
  private var latest: NWPath?

  public func definition() -> ModuleDefinition {
    Name("NetworkCost")

    Events("onChange")

    /// The last path iOS reported, or null before its first report.
    Function("current") { () -> [String: Bool]? in
      self.startMonitoring()
      self.lock.lock()
      defer { self.lock.unlock() }

      return self.latest.map(Self.reading)
    }

    OnStartObserving("onChange") {
      self.startMonitoring()
    }

    OnDestroy {
      self.lock.lock()
      defer { self.lock.unlock() }
      self.monitor?.cancel()
      self.monitor = nil
    }
  }

  private static func reading(_ path: NWPath) -> [String: Bool] {
    [
      "connected": path.status == .satisfied,
      "expensive": path.isExpensive,
      "constrained": path.isConstrained,
    ]
  }

  private func startMonitoring() {
    lock.lock()
    defer { lock.unlock() }

    guard monitor == nil else { return }
    let started = NWPathMonitor()

    started.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      self.lock.lock()
      self.latest = path
      self.lock.unlock()
      self.sendEvent("onChange", Self.reading(path))
    }

    started.start(queue: queue)
    monitor = started
  }
}
