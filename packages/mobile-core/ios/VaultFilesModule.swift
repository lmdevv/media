import ExpoModulesCore

/// Keeps downloads out of iCloud and computer backups: a video or a song the server can send again
/// doesn't belong in someone's backup. The flag goes on the folder that holds the downloads, and
/// iOS leaves out everything in it, including files written or renamed later. expo-file-system
/// can't set it. Both Lar apps load this module from @media/mobile-core.
public final class VaultFilesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VaultFiles")

    Function("excludeFromBackup") { (directory: URL) in
      var url = directory
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    }
  }
}
