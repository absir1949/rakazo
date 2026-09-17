import { describe, expect, it } from "vitest";
import { applySceneLifecycleToAppDelegate, applySceneManifest } from "./with-scene-lifecycle.js";

// Matches expo@57.0.23's prebuilt AppDelegate template.
const TEMPLATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func bundleURL() -> URL? {
    nil
  }
}
`;

describe("applySceneLifecycleToAppDelegate", () => {
  it("moves window creation into a scene delegate", () => {
    const result = applySceneLifecycleToAppDelegate(TEMPLATE);

    expect(result).toContain("configuration.delegateClass = SceneDelegate.self");
    expect(result).toContain("let window = UIWindow(windowScene: windowScene)");
    expect(result).toContain("class SceneDelegate: UIResponder, UIWindowSceneDelegate");
    expect(result).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
    // React Native still receives the launch options captured at app launch.
    expect(result).toContain("self.launchOptions = launchOptions");
    expect(result).toContain("launchOptions: appDelegate.launchOptions");
    // Cold-start deep links still reach React Linking.
    expect(result).toContain("connectionOptions.urlContexts.first?.url");
    // Pre-existing template behavior is untouched.
    expect(result).toContain("RCTLinkingManager.application(app, open: url, options: options)");
    expect(result).toContain("class ReactNativeDelegate: ExpoReactNativeFactoryDelegate");
  });

  it("is idempotent", () => {
    const once = applySceneLifecycleToAppDelegate(TEMPLATE);
    expect(applySceneLifecycleToAppDelegate(once)).toBe(once);
  });

  it("fails loudly when the Expo template drifts", () => {
    expect(() => applySceneLifecycleToAppDelegate("class AppDelegate: ExpoAppDelegate {}")).toThrow(
      /template changed/,
    );
  });
});

describe("applySceneManifest", () => {
  it("declares a single-scene manifest pointing at SceneDelegate", () => {
    const infoPlist = applySceneManifest({});

    expect(infoPlist.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "main",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    });
  });
});
