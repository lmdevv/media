Pod::Spec.new do |s|
  s.name           = 'LaunchClock'
  s.version        = '1.0.0'
  s.summary        = 'When the process started, for timing a cold launch of the Lar Movies app.'
  s.license        = 'MIT'
  s.author         = 'Lar Movies'
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
