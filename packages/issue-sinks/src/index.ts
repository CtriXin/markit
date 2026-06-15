export type IssueSinkKind = 'local-evidence' | 'clipboard-markdown' | 'feishu-later';

export type IssueSinkDescriptor = {
  kind: IssueSinkKind;
  enabled: boolean;
};

export const defaultIssueSinks: IssueSinkDescriptor[] = [
  { kind: 'local-evidence', enabled: true },
  { kind: 'clipboard-markdown', enabled: true },
  { kind: 'feishu-later', enabled: false }
];
