Pod::Spec.new do |s|
  s.name           = 'ContentScroll'
  s.version        = '1.0.0'
  s.summary        = 'Tells UIKit which scroll view is a page’s content, for the [music] app.'
  s.license        = 'MIT'
  s.author         = '[music]'
  s.homepage       = 'https://github.com/lmdevv/music'
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
