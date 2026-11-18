Pod::Spec.new do |s|
  s.name           = 'RemoteCommands'
  s.version        = '1.0.0'
  s.summary        = 'The system playback commands, and headphones unplugged, for the [music] app.'
  s.license        = 'MIT'
  s.author         = '[music]'
  s.homepage       = 'https://github.com/lmdevv/media'
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
