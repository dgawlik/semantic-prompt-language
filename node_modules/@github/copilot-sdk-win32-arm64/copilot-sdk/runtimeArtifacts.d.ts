export interface RuntimeArtifactSources {
    packageRoot: string;
    platform: string;
}
export interface EnsureRuntimeBundleOptions {
    cacheRoot?: string;
    packageSearchPaths?: string[];
    platform?: string;
}
export declare const RUNTIME_PLATFORMS: readonly ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "linuxmusl-arm64", "linuxmusl-x64", "win32-arm64", "win32-x64"];
export declare function validateFile(path: string, label: string): void;
export declare function defaultRuntimeCacheRoot(platform?: NodeJS.Platform, home?: string, environment?: NodeJS.ProcessEnv): string;
export declare function materializeRuntimeBundle(sources: RuntimeArtifactSources, cacheRoot?: string, cacheKey?: string): string;
export declare function getRuntimePlatform(platform?: NodeJS.Platform, arch?: NodeJS.Architecture, musl?: boolean): string;
export declare function getRuntimeReleaseAssetName(version: string, platform: string): string;
export declare function getRuntimePackageName(platform: string): string;
export declare function resolvePackageRoot(packageName: string, searchPaths?: string[]): string | undefined;
export declare function ensureRuntimeBundle(version: string, options?: EnsureRuntimeBundleOptions): Promise<string>;
