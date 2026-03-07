import packageManifest from "../package.json" with { type: "json" };

export const PACKAGE_NAME = packageManifest.name;
export const PACKAGE_VERSION = packageManifest.version;
export const PACKAGE_DESCRIPTION = packageManifest.description;
