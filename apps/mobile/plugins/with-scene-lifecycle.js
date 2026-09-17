const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const LAUNCHING_BLOCK = `    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

const LAUNCHING_BLOCK_REPLACEMENT = `    reactNativeDelegate = delegate
    reactNativeFactory = factory
    self.launchOptions = launchOptions

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

const LINKING_MARKER = "  // Linking API";

const CONFIGURATION_FOR_CONNECTING = `  // Apps built with the iOS 26 SDK must adopt the UIScene life cycle.
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "main",
      sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

`;

const SCENE_DELEGATE = `
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: appDelegate.launchOptions)

    if let url = connectionOptions.urlContexts.first?.url {
      _ = RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    _ = RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }
}
`;

/**
 * iOS 26 refuses to launch apps built with the iOS 26 SDK unless they adopt
 * the UIScene life cycle. Expo's SDK 57 AppDelegate template still creates a
 * bare UIWindow in didFinishLaunching, so a prebuild from a current Xcode
 * crashes at startup on iOS 26 devices. Declare a scene manifest and move
 * React Native's window creation into a scene delegate.
 */
function withSceneLifecycle(config) {
  config = withAppDelegate(config, (config) => {
    config.modResults.contents = applySceneLifecycleToAppDelegate(config.modResults.contents);
    return config;
  });

  config = withInfoPlist(config, (config) => {
    applySceneManifest(config.modResults);
    return config;
  });

  return config;
}

function applySceneManifest(infoPlist) {
  infoPlist.UIApplicationSceneManifest = {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        {
          UISceneConfigurationName: "main",
          UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
        },
      ],
    },
  };
  return infoPlist;
}

function applySceneLifecycleToAppDelegate(contents) {
  if (contents.includes("class SceneDelegate")) {
    return contents;
  }

  let next = contents.replace(
    "  var window: UIWindow?\n",
    "  var window: UIWindow?\n  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n",
  );

  if (contents.includes(LAUNCHING_BLOCK)) {
    next = next.replace(LAUNCHING_BLOCK, LAUNCHING_BLOCK_REPLACEMENT);
  } else {
    throw new Error(
      "with-scene-lifecycle: Expo AppDelegate template changed; update the plugin's anchor strings.",
    );
  }

  next = next.replace(LINKING_MARKER, `${CONFIGURATION_FOR_CONNECTING}${LINKING_MARKER}`);
  return `${next}\n${SCENE_DELEGATE}`;
}

module.exports = withSceneLifecycle;
module.exports.applySceneLifecycleToAppDelegate = applySceneLifecycleToAppDelegate;
module.exports.applySceneManifest = applySceneManifest;
