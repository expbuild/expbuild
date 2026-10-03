// Profiles describe configuration recipes, not certified client compatibility.
export function clientProfiles(name: string, version: string | null | undefined) {
  if (name === 'bazel-remote' && version === '0.1.0') {
    return [{ id: 'pants', protocol: 'reapi', version: '2.33.1', status: 'experimental' as const }];
  }
  if (name === 'webdav-apache' && ['0.1.0', '0.2.0'].includes(version ?? '')) {
    return [
      { id: 'sccache', protocol: 'webdav', version: '0.18.0', status: 'experimental' as const },
      { id: 'maven-build-cache', protocol: 'webdav', version: '1.3.0', status: 'experimental' as const },
    ];
  }
  return [];
}
