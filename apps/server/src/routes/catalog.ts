import { Router } from 'express';
import { listCatalogDomains, loadCatalog, resolveCatalogUrl, searchCatalogProjects, type CatalogOptions } from '../catalog.js';
import { asyncHandler } from './helpers.js';

export function catalogRouter(options: CatalogOptions = {}): Router {
  const router = Router();

  router.get('/api/catalog/status', asyncHandler(async (_req, res) => {
    const catalog = await loadCatalog(options);
    res.json(catalog.status);
  }));

  router.get('/api/catalog/projects', asyncHandler(async (req, res) => {
    const catalog = await loadCatalog(options);
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const limit = Number(req.query.limit ?? 100);
    res.json({ status: catalog.status, projects: searchCatalogProjects(catalog, query, Number.isFinite(limit) ? limit : 100) });
  }));

  router.get('/api/catalog/domains', asyncHandler(async (req, res) => {
    const catalog = await loadCatalog(options);
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    res.json({ status: catalog.status, domains: listCatalogDomains(catalog, projectId) });
  }));

  router.get('/api/catalog/resolve', asyncHandler(async (req, res) => {
    const catalog = await loadCatalog(options);
    const input = typeof req.query.url === 'string' ? req.query.url : '';
    res.json(resolveCatalogUrl(catalog, input));
  }));

  return router;
}
