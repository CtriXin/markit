import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const DEFAULT_CATALOG_ROOT = '';

export type CatalogOptions = {
  root?: string;
  env?: NodeJS.ProcessEnv;
};

export type CatalogStatus = {
  schema: 'markit.catalog.status.v1';
  enabled: boolean;
  root: string;
  reason?: string;
  generatedAt?: string;
  projectCount?: number;
  domainCount?: number;
  source?: {
    kind?: string;
    generatedAt?: string;
    pendingAssociations?: number;
  };
  integration?: {
    consumer?: string;
    repo?: string;
    syncPolicy?: string;
  };
};

export type CatalogProject = {
  id: string;
  name: string;
  status: string;
  aliases: string[];
  domainCount: number;
  activeDomainCount: number;
  pendingDomainCount: number;
  scmpService?: string;
  gitlabPath?: string;
  activeBranch?: string;
  issueProjectPath?: string;
  defaultAssignee?: string;
  defaultAssignees?: string[];
  labels?: string[];
  owners?: {
    qa?: string[];
    dev?: string[];
  };
  testing?: {
    enabled: boolean;
    defaultViewport: string;
    viewports: string[];
  };
  confidence?: number;
  notes?: string[];
};

export type CatalogDomain = {
  host: string;
  url: string;
  projectId: string;
  projectName: string;
  env: string;
  status: string;
  scmpService?: string;
  gitlabPath?: string;
  activeBranch?: string;
  defaultAssignee?: string;
  defaultAssignees?: string[];
  source?: string;
  confidence?: number;
};

export type LoadedCatalog = {
  status: CatalogStatus;
  projects: CatalogProject[];
  projectMap: Map<string, CatalogProject>;
  domainsByHost: Map<string, CatalogDomain>;
  projectDomainsById: Map<string, CatalogDomain[]>;
};

export type CatalogResolveResult = {
  status: CatalogStatus;
  input: string;
  hostname?: string;
  matched: boolean;
  matchedHost?: string;
  reason?: string;
  domain?: CatalogDomain;
  project?: CatalogProject;
};

export type ProjectSnapshot = {
  schema: 'markit.project-snapshot.v1';
  source: 'client' | 'catalog-resolve';
  capturedAt: string;
  catalogRoot?: string;
  catalogGeneratedAt?: string;
  project: {
    id: string;
    name: string;
    status: string;
    scmpService?: string;
    gitlabPath?: string;
    activeBranch?: string;
    issueProjectPath?: string;
    defaultAssignee?: string;
    defaultAssignees?: string[];
    labels?: string[];
    confidence?: number;
  };
  domain?: {
    host: string;
    url: string;
    env: string;
    status: string;
    activeBranch?: string;
    matchedHost?: string;
    defaultAssignee?: string;
    defaultAssignees?: string[];
  };
};

type RawBinding = {
  consumer?: { id?: string; repo?: string };
  catalog?: { manifest?: string; domainIndex?: string; projectsGlob?: string };
  workflow?: { syncPolicy?: string };
};

type RawManifest = {
  generatedAt?: string;
  projectCount?: number;
  domainCount?: number;
  domainIndex?: string;
  projects?: string[];
  source?: {
    kind?: string;
    generatedAt?: string;
    pendingAssociations?: number;
  };
};

type RawProject = {
  id?: string;
  name?: string;
  aliases?: string[];
  status?: string;
  scmp?: { service?: string };
  repo?: { gitlabPath?: string; activeBranch?: string };
  domains?: Array<{ host?: string; env?: string; status?: string; source?: string }>;
  gitlab?: { issueProjectPath?: string; defaultAssignee?: string; defaultAssignees?: string[]; labels?: string[] };
  testing?: { enabled?: boolean; defaultViewport?: string; viewports?: string[] };
  owners?: { qa?: string[]; dev?: string[] };
  confidence?: number;
  notes?: string[];
};

type RawDomainIndex = {
  domains?: Record<string, RawDomainEntry>;
};

type RawDomainEntry = {
  projectId?: string;
  projectName?: string;
  scmpService?: string;
  gitlabPath?: string;
  activeBranch?: string;
  defaultAssignee?: string;
  defaultAssignees?: string[];
  env?: string;
  status?: string;
};

export async function loadCatalog(options: CatalogOptions = {}): Promise<LoadedCatalog> {
  const root = resolveCatalogRoot(options);
  const disabled = (reason: string): LoadedCatalog => disabledCatalog(root, reason);
  if (!(await exists(root))) return disabled('catalog_root_missing');

  const bindingPath = resolve(root, 'integrations/markit.json');
  if (!(await exists(bindingPath))) return disabled('markit_binding_missing');

  try {
    const binding = await readJson<RawBinding>(bindingPath);
    const manifestPath = resolveCatalogPath(root, binding.catalog?.manifest ?? 'catalog/catalog.manifest.json');
    const manifest = await readJson<RawManifest>(manifestPath);
    const manifestDir = dirname(manifestPath);
    const domainIndexPath = binding.catalog?.domainIndex
      ? resolveCatalogPath(root, binding.catalog.domainIndex)
      : resolveCatalogPath(manifestDir, manifest.domainIndex ?? 'domains.json');
    const domainIndex = await readJson<RawDomainIndex>(domainIndexPath);
    const projectPaths = await resolveProjectPaths(root, manifestDir, manifest, binding);
    const rawProjects = await Promise.all(projectPaths.map(async (path) => readJson<RawProject>(path).catch(() => undefined)));
    const projects = rawProjects.map((project) => project ? toProject(project) : undefined).filter((project): project is CatalogProject => Boolean(project));
    projects.sort(compareProjects);

    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const projectDomainsById = new Map<string, CatalogDomain[]>();
    for (const rawProject of rawProjects) {
      if (!rawProject?.id || !rawProject.name) continue;
      for (const domain of projectDomains(rawProject)) appendProjectDomain(projectDomainsById, domain);
    }

    const domainsByHost = new Map<string, CatalogDomain>();
    for (const [host, entry] of Object.entries(domainIndex.domains ?? {})) {
      const domain = domainFromIndex(host, entry, projectMap.get(entry.projectId ?? ''));
      if (!domain) continue;
      domainsByHost.set(normalizeHost(domain.host), domain);
      appendProjectDomain(projectDomainsById, domain);
    }
    for (const [projectId, domains] of projectDomainsById.entries()) {
      const projectDomains = sortDomains(dedupeDomains(domains));
      projectDomainsById.set(projectId, projectDomains);
      syncProjectDomainCounts(projectMap.get(projectId), projectDomains);
    }

    return {
      status: enabledStatus(root, manifest, binding, projects.length, domainsByHost.size),
      projects,
      projectMap,
      domainsByHost,
      projectDomainsById
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return disabled(`catalog_read_failed: ${message}`);
  }
}

export function searchCatalogProjects(catalog: LoadedCatalog, query = '', limit = 100): CatalogProject[] {
  if (!catalog.status.enabled) return [];
  const normalizedQuery = query.trim().toLowerCase();
  const projects = normalizedQuery
    ? catalog.projects.filter((project) => projectSearchText(project, catalog.projectDomainsById.get(project.id) ?? []).includes(normalizedQuery))
    : catalog.projects;
  return projects.filter((project) => project.domainCount > 0).slice(0, Math.max(1, Math.min(limit, 250)));
}

export function listCatalogDomains(catalog: LoadedCatalog, projectId: string): CatalogDomain[] {
  if (!catalog.status.enabled) return [];
  return catalog.projectDomainsById.get(projectId) ?? [];
}

export function resolveCatalogUrl(catalog: LoadedCatalog, input: string): CatalogResolveResult {
  const trimmedInput = input.trim();
  const hostname = hostnameFromInput(trimmedInput);
  if (!hostname) return { status: catalog.status, input: trimmedInput, matched: false, reason: 'invalid_url' };
  if (!catalog.status.enabled) {
    return { status: catalog.status, input: trimmedInput, hostname, matched: false, reason: catalog.status.reason ?? 'catalog_disabled' };
  }
  const candidates = candidateHosts(hostname);
  for (const candidate of candidates) {
    const domain = catalog.domainsByHost.get(candidate);
    if (!domain) continue;
    const result: CatalogResolveResult = {
      status: catalog.status,
      input: trimmedInput,
      hostname,
      matched: true,
      matchedHost: domain.host,
      domain
    };
    const project = catalog.projectMap.get(domain.projectId);
    if (project) result.project = project;
    return result;
  }
  return { status: catalog.status, input: trimmedInput, hostname, matched: false, reason: 'domain_not_found' };
}

export function projectSnapshotFromCatalog(input: {
  status: CatalogStatus;
  project: CatalogProject;
  domain?: CatalogDomain;
  matchedHost?: string;
  source?: ProjectSnapshot['source'];
  capturedAt?: string;
}): ProjectSnapshot {
  const snapshot: ProjectSnapshot = {
    schema: 'markit.project-snapshot.v1',
    source: input.source ?? 'catalog-resolve',
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    project: {
      id: input.project.id,
      name: input.project.name,
      status: input.project.status
    }
  };
  if (input.status.root) snapshot.catalogRoot = input.status.root;
  if (input.status.generatedAt) snapshot.catalogGeneratedAt = input.status.generatedAt;
  if (input.project.scmpService) snapshot.project.scmpService = input.project.scmpService;
  if (input.project.gitlabPath) snapshot.project.gitlabPath = input.project.gitlabPath;
  if (input.project.activeBranch) snapshot.project.activeBranch = input.project.activeBranch;
  if (input.project.issueProjectPath) snapshot.project.issueProjectPath = input.project.issueProjectPath;
  if (input.project.defaultAssignee) snapshot.project.defaultAssignee = input.project.defaultAssignee;
  if (input.project.defaultAssignees?.length) snapshot.project.defaultAssignees = input.project.defaultAssignees;
  if (input.project.labels?.length) snapshot.project.labels = input.project.labels;
  if (typeof input.project.confidence === 'number') snapshot.project.confidence = input.project.confidence;
  if (input.domain) {
    snapshot.domain = {
      host: input.domain.host,
      url: input.domain.url,
      env: input.domain.env,
      status: input.domain.status
    };
    if (input.domain.activeBranch) snapshot.domain.activeBranch = input.domain.activeBranch;
    if (input.matchedHost) snapshot.domain.matchedHost = input.matchedHost;
    if (input.domain.defaultAssignee) snapshot.domain.defaultAssignee = input.domain.defaultAssignee;
    if (input.domain.defaultAssignees?.length) snapshot.domain.defaultAssignees = input.domain.defaultAssignees;
  }
  return snapshot;
}

function resolveCatalogRoot(options: CatalogOptions): string {
  const env = options.env ?? process.env;
  const root = options.root ?? env.MARKIT_CATALOG_ROOT ?? DEFAULT_CATALOG_ROOT;
  return root ? resolve(root) : '';
}

function disabledCatalog(root: string, reason: string): LoadedCatalog {
  return {
    status: { schema: 'markit.catalog.status.v1', enabled: false, root, reason },
    projects: [],
    projectMap: new Map(),
    domainsByHost: new Map(),
    projectDomainsById: new Map()
  };
}

function enabledStatus(root: string, manifest: RawManifest, binding: RawBinding, projectCount: number, domainCount: number): CatalogStatus {
  const status: CatalogStatus = {
    schema: 'markit.catalog.status.v1',
    enabled: true,
    root,
    projectCount,
    domainCount
  };
  if (manifest.generatedAt) status.generatedAt = manifest.generatedAt;
  if (manifest.source) {
    status.source = {};
    if (manifest.source.kind) status.source.kind = manifest.source.kind;
    if (manifest.source.generatedAt) status.source.generatedAt = manifest.source.generatedAt;
    if (typeof manifest.source.pendingAssociations === 'number') status.source.pendingAssociations = manifest.source.pendingAssociations;
  }
  status.integration = {};
  if (binding.consumer?.id) status.integration.consumer = binding.consumer.id;
  if (binding.consumer?.repo) status.integration.repo = binding.consumer.repo;
  if (binding.workflow?.syncPolicy) status.integration.syncPolicy = binding.workflow.syncPolicy;
  return status;
}

async function resolveProjectPaths(root: string, manifestDir: string, manifest: RawManifest, binding: RawBinding): Promise<string[]> {
  if (manifest.projects?.length) return manifest.projects.map((path) => resolveCatalogPath(manifestDir, path));
  const glob = binding.catalog?.projectsGlob ?? 'catalog/projects/*.json';
  const star = glob.indexOf('*');
  const dir = resolveCatalogPath(root, star === -1 ? dirname(glob) : dirname(glob.slice(0, star)));
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith('.json')).map((name) => resolve(dir, name));
}

function toProject(raw: RawProject): CatalogProject | undefined {
  if (!raw.id || !raw.name) return undefined;
  const domains = raw.domains ?? [];
  const project: CatalogProject = {
    id: raw.id,
    name: raw.name,
    status: raw.status ?? 'unknown',
    aliases: raw.aliases ?? [],
    domainCount: domains.length,
    activeDomainCount: domains.filter((domain) => domain.status === 'active').length,
    pendingDomainCount: domains.filter((domain) => domain.status === 'pending').length
  };
  if (raw.scmp?.service) project.scmpService = raw.scmp.service;
  if (raw.repo?.gitlabPath) project.gitlabPath = raw.repo.gitlabPath;
  if (raw.repo?.activeBranch) project.activeBranch = raw.repo.activeBranch;
  if (raw.gitlab?.issueProjectPath) project.issueProjectPath = raw.gitlab.issueProjectPath;
  if (raw.gitlab?.defaultAssignee) project.defaultAssignee = raw.gitlab.defaultAssignee;
  const defaultAssignees = normalizeStringList(raw.gitlab?.defaultAssignees?.length ? raw.gitlab.defaultAssignees : raw.gitlab?.defaultAssignee);
  if (defaultAssignees.length) project.defaultAssignees = defaultAssignees;
  if (raw.gitlab?.labels?.length) project.labels = raw.gitlab.labels;
  if (raw.owners) {
    const owners: CatalogProject['owners'] = {};
    if (raw.owners.qa?.length) owners.qa = raw.owners.qa;
    if (raw.owners.dev?.length) owners.dev = raw.owners.dev;
    if (owners.qa || owners.dev) project.owners = owners;
  }
  if (raw.testing) {
    project.testing = {
      enabled: Boolean(raw.testing.enabled),
      defaultViewport: raw.testing.defaultViewport ?? 'desktop-1440',
      viewports: raw.testing.viewports ?? []
    };
  }
  if (typeof raw.confidence === 'number') project.confidence = raw.confidence;
  if (raw.notes?.length) project.notes = raw.notes;
  return project;
}

function syncProjectDomainCounts(project: CatalogProject | undefined, domains: CatalogDomain[]) {
  if (!project) return;
  project.domainCount = domains.length;
  project.activeDomainCount = domains.filter((domain) => domain.status === 'active').length;
  project.pendingDomainCount = domains.filter((domain) => domain.status === 'pending').length;
}

function projectDomains(raw: RawProject): CatalogDomain[] {
  if (!raw.id || !raw.name) return [];
  const projectId = raw.id;
  const projectName = raw.name;
  return (raw.domains ?? []).map((domain) => {
    if (!domain.host) return undefined;
    const host = normalizeHost(domain.host);
    const item: CatalogDomain = {
      host,
      url: `https://${host}`,
      projectId,
      projectName,
      env: domain.env ?? 'unknown',
      status: domain.status ?? 'unknown'
    };
    if (raw.scmp?.service) item.scmpService = raw.scmp.service;
    if (raw.repo?.gitlabPath) item.gitlabPath = raw.repo.gitlabPath;
    if (raw.repo?.activeBranch) item.activeBranch = raw.repo.activeBranch;
    if (raw.gitlab?.defaultAssignee) item.defaultAssignee = raw.gitlab.defaultAssignee;
    const defaultAssignees = normalizeStringList(raw.gitlab?.defaultAssignees?.length ? raw.gitlab.defaultAssignees : raw.gitlab?.defaultAssignee);
    if (defaultAssignees.length) item.defaultAssignees = defaultAssignees;
    if (domain.source) item.source = domain.source;
    if (typeof raw.confidence === 'number') item.confidence = raw.confidence;
    return item;
  }).filter((domain): domain is CatalogDomain => Boolean(domain));
}

function domainFromIndex(host: string, entry: RawDomainEntry, project?: CatalogProject): CatalogDomain | undefined {
  const projectId = entry.projectId ?? project?.id;
  const projectName = entry.projectName ?? project?.name;
  if (!projectId || !projectName) return undefined;
  const normalizedHost = normalizeHost(host);
  const domain: CatalogDomain = {
    host: normalizedHost,
    url: `https://${normalizedHost}`,
    projectId,
    projectName,
    env: entry.env ?? 'unknown',
    status: entry.status ?? 'unknown'
  };
  const scmpService = entry.scmpService ?? project?.scmpService;
  const gitlabPath = entry.gitlabPath ?? project?.gitlabPath;
  const activeBranch = entry.activeBranch ?? project?.activeBranch;
  const defaultAssignees = normalizeStringList(
    entry.defaultAssignees?.length ? entry.defaultAssignees
      : entry.defaultAssignee ? entry.defaultAssignee
        : project?.defaultAssignees?.length ? project.defaultAssignees
          : project?.defaultAssignee
  );
  const defaultAssignee = defaultAssignees[0];
  if (scmpService) domain.scmpService = scmpService;
  if (gitlabPath) domain.gitlabPath = gitlabPath;
  if (activeBranch) domain.activeBranch = activeBranch;
  if (defaultAssignee) domain.defaultAssignee = defaultAssignee;
  if (defaultAssignees.length) domain.defaultAssignees = defaultAssignees;
  if (typeof project?.confidence === 'number') domain.confidence = project.confidence;
  return domain;
}

function appendProjectDomain(map: Map<string, CatalogDomain[]>, domain: CatalogDomain) {
  const current = map.get(domain.projectId) ?? [];
  current.push(domain);
  map.set(domain.projectId, current);
}

function dedupeDomains(domains: CatalogDomain[]): CatalogDomain[] {
  const seen = new Set<string>();
  const deduped: CatalogDomain[] = [];
  for (const domain of domains.slice().reverse()) {
    const key = normalizeHost(domain.host);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(domain);
  }
  return deduped.reverse();
}

function sortDomains(domains: CatalogDomain[]): CatalogDomain[] {
  const statusWeight: Record<string, number> = { active: 0, pending: 1, unknown: 2, archived: 3 };
  const envWeight: Record<string, number> = { prod: 0, stage: 1, test: 2, dev: 3, unknown: 4 };
  return domains.slice().sort((a, b) => {
    const statusDelta = (statusWeight[a.status] ?? 9) - (statusWeight[b.status] ?? 9);
    if (statusDelta) return statusDelta;
    const envDelta = (envWeight[a.env] ?? 9) - (envWeight[b.env] ?? 9);
    if (envDelta) return envDelta;
    return a.host.localeCompare(b.host);
  });
}

function compareProjects(a: CatalogProject, b: CatalogProject): number {
  const statusWeight: Record<string, number> = { active: 0, draft: 1, unknown: 2, archived: 3 };
  const statusDelta = (statusWeight[a.status] ?? 9) - (statusWeight[b.status] ?? 9);
  if (statusDelta) return statusDelta;
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

function projectSearchText(project: CatalogProject, domains: CatalogDomain[]): string {
  return [
    project.id,
    project.name,
    ...project.aliases,
    project.scmpService,
    project.gitlabPath,
    project.activeBranch,
    project.issueProjectPath,
    ...domains.map((domain) => domain.host)
  ].filter(Boolean).join(' ').toLowerCase();
}

function hostnameFromInput(input: string): string | undefined {
  if (!input) return undefined;
  try {
    return normalizeHost(new URL(input.includes('://') ? input : `https://${input}`).hostname);
  } catch {
    return undefined;
  }
}

function candidateHosts(hostname: string): string[] {
  const normalized = normalizeHost(hostname);
  const candidates = [normalized];
  if (normalized.startsWith('www.')) candidates.push(normalized.slice(4));
  else candidates.push(`www.${normalized}`);
  return [...new Set(candidates)];
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function normalizeStringList(value: string | string[] | undefined): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(rawItems.flatMap((item) => item.split(/[,，、;；\n]+/)).map((item) => item.trim()).filter(Boolean))];
}

function resolveCatalogPath(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim()) ?? '';
}
