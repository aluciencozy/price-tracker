import type { ZodError } from 'zod';

export type ApiFieldCode = 'required' | 'unknown_field' | 'invalid_type' | 'out_of_range' | 'invalid_format' | 'unsupported' | 'invalid_value';
export type ApiFieldError = { path: string; code: ApiFieldCode; message: string };

export class TrackingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: ApiFieldError[] = [],
    public readonly retryAfterSeconds: number | null = null,
    public readonly resourceId: string | null = null,
  ) {
    super(message);
    this.name = 'TrackingError';
  }
}

function isMissingInput(path: PropertyKey[], input: unknown): boolean {
  if (path.length === 0) return input === undefined;
  let parent = input;
  for (const part of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return false;
    parent = (parent as Record<PropertyKey, unknown>)[part];
  }
  const key = path.at(-1)!;
  return parent !== null && typeof parent === 'object' &&
    (!Object.prototype.hasOwnProperty.call(parent, key) || (parent as Record<PropertyKey, unknown>)[key] === undefined);
}

export function validationError(error: ZodError, input?: unknown): TrackingError {
  const fields = error.issues.flatMap(issue => {
    const code: ApiFieldError['code'] = issue.code === 'unrecognized_keys'
      ? 'unknown_field'
      : issue.code === 'too_small' || issue.code === 'too_big' || issue.code === 'not_multiple_of'
        ? 'out_of_range'
        : issue.code === 'invalid_format'
          ? 'invalid_format'
          : issue.code === 'invalid_type'
            ? (isMissingInput(issue.path, input) ? 'required' : 'invalid_type')
            : 'invalid_value';
    const pointer = (parts: PropertyKey[]) => {
      const path = `/${parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
      return path.length <= 300 ? path : '/body';
    };
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map(key => ({ path: pointer([...issue.path, key]), code, message: 'Unknown field.' }));
    }
    return [{
      path: issue.path.length === 0 ? '/body' : pointer(issue.path),
      code,
      message: issue.message.slice(0, 300),
    }];
  }).slice(0, 50);
  return new TrackingError(422, 'VALIDATION_ERROR', 'Check the request fields.', fields);
}

export function notFound(): TrackingError {
  return new TrackingError(404, 'NOT_FOUND', 'Tracked item not found.');
}
