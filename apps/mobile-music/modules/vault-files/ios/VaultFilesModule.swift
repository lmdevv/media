import ExpoModulesCore

/// Downloads live in Application Support, which iOS never purges but does back up. A song the
/// server can send again doesn't belong in someone's iCloud backup, so the downloads directory
/// is excluded; the flag on a directory covers everything in it. expo-file-system can't set it.
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
