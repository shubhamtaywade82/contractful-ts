/**
 * Route parsing and path building.
 *
 * Routes are declared as `'VERB /path/:with/:placeholders'` — the same shape
 * contractful uses. Path parameters are substituted with URI-escaped values
 * and removed from the remaining argument pool.
 */

import { PathBuildError } from '../errors.js';
import type { HttpMethod } from '../types.js';
import { HTTP_METHODS } from '../types.js';

export interface ParsedRoute {
  method: HttpMethod;
  /** Path template, e.g. `/repos/:owner/:repo/issues`. */
  template: string;
  /** Parameter names referenced by the template, in order. */
  pathParams: string[];
}

export interface BuiltPath {
  /** The path with all placeholders substituted. */
  path: string;
  /** Values that were consumed from the input pool. */
  consumed: Record<string, unknown>;
}

/** Thrown when a route string is malformed (unknown verb, no path, ...). */
export class RouteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteParseError';
  }
}

const PATH_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Parses `'GET /repos/:owner/:repo/issues'` into its components. */
export function parseRoute(route: string): ParsedRoute {
  const trimmed = route.trim();
  const match = /^([A-Za-z]+)\s+(.+)$/.exec(trimmed);
  if (!match) {
    throw new RouteParseError(
      `Route ${JSON.stringify(route)} must look like 'GET /users/:id' (verb + path)`,
    );
  }
  const verb = match[1]!.toUpperCase() as HttpMethod;
  if (!HTTP_METHODS.includes(verb)) {
    throw new RouteParseError(
      `Unknown HTTP verb ${JSON.stringify(match[1])} in route ${JSON.stringify(route)}`,
    );
  }
  let template = match[2]!.trim();
  if (!template.startsWith('/')) {
    throw new RouteParseError(
      `Route path ${JSON.stringify(template)} must start with '/'`,
    );
  }
  // Reject duplicate placeholders like /:a/:a.
  const seen = new Set<string>();
  for (const m of template.matchAll(PATH_PARAM_RE)) {
    const name = m[1]!;
    if (seen.has(name)) {
      throw new RouteParseError(`Duplicate path parameter :${name} in route ${JSON.stringify(route)}`);
    }
    seen.add(name);
  }
  return {
    method: verb,
    template,
    pathParams: [...seen],
  };
}

/**
 * Substitutes path parameters into the template. Missing (or nullish) values
 * raise a {@link PathBuildError}; values are stringified and URI-escaped.
 */
export function buildPath(
  template: string,
  pool: Record<string, unknown>,
): BuiltPath {
  const missing: string[] = [];
  const consumed: Record<string, unknown> = {};

  const path = template.replace(PATH_PARAM_RE, (_whole, name: string) => {
    const value = pool[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return `:${name}`;
    }
    consumed[name] = value;
    return encodeURIComponent(String(value));
  });

  if (missing.length > 0) {
    throw new PathBuildError(template, missing);
  }

  return { path, consumed };
}
