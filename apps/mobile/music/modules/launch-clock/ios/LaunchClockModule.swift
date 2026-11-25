import Darwin
import ExpoModulesCore

/// When this process started, as the kernel records it, so a cold launch's timing includes the
/// native start-up that runs ahead of JavaScript (`@media/mobile-core/app-events`).
///
/// `processStartedAt` answers epoch milliseconds, or null when the kernel does not say or iOS
/// prewarmed the process: a prewarmed process starts before anyone opens the app, so its start
/// says nothing about how long the launch took.
public final class LaunchClockModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LaunchClock")

    Function("processStartedAt") { () -> Double? in
      processStartedAt()
    }
  }
}

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

  return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
}
