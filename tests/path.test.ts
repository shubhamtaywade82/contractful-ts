import { describe, expect, it } from 'vitest';
import { buildPath, parseRoute, RouteParseError } from '../src/http/path.js';
import { PathBuildError } from '../src/errors.js';

describe('parseRoute', () => {
  it('parses verb, template and path params', () => {
    const route = parseRoute('GET /repos/:owner/:repo/issues');
    expect(route.method).toBe('GET');
    expect(route.template).toBe('/repos/:owner/:repo/issues');
    expect(route.pathParams).toEqual(['owner', 'repo']);
  });

  it('upper-cases the verb', () => {
    expect(parseRoute('post /things').method).toBe('POST');
  });

  it('rejects unknown verbs', () => {
    expect(() => parseRoute('BREW /coffee')).toThrow(RouteParseError);
  });

  it('rejects paths without a leading slash', () => {
    expect(() => parseRoute('GET users')).toThrow(RouteParseError);
  });

  it('rejects duplicate path params', () => {
    expect(() => parseRoute('GET /:a/:a')).toThrow(RouteParseError);
  });
});

describe('buildPath', () => {
  it('substitutes and consumes path params', () => {
    const built = buildPath('/repos/:owner/:repo/issues', {
      owner: 'octocat',
      repo: 'hello world',
      page: 2,
    });
    expect(built.path).toBe('/repos/octocat/hello%20world/issues');
    expect(built.consumed).toEqual({ owner: 'octocat', repo: 'hello world' });
  });

  it('stringifies numbers and booleans', () => {
    const built = buildPath('/users/:id/:flag', { id: 42, flag: true });
    expect(built.path).toBe('/users/42/true');
  });

  it('URI-escapes special characters', () => {
    const built = buildPath('/users/:name', { name: 'a/b?c#d' });
    expect(built.path).toBe('/users/a%2Fb%3Fc%23d');
  });

  it('throws PathBuildError when a path param is missing', () => {
    expect(() => buildPath('/repos/:owner/:repo', { owner: 'x' })).toThrow(PathBuildError);
  });

  it('treats empty strings as missing', () => {
    expect(() => buildPath('/repos/:owner', { owner: '' })).toThrow(PathBuildError);
  });

  it('leaves routes without placeholders untouched', () => {
    expect(buildPath('/users', { page: 1 }).path).toBe('/users');
  });
});
