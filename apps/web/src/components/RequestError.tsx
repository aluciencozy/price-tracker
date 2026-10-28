import { errorDetails } from '../data/useRetryWait';
export function RequestError({ error }: { error: unknown }) {
  const data = errorDetails(error);
  return <>
    <p>{error instanceof Error ? error.message : 'Request failed. Please try again.'}</p>
    {data?.fields?.length ? <ul>{data.fields.map((field, index) => <li key={`${field.path}:${index}`}>{field.path}: {field.message}</li>)}</ul> : null}
    {data?.retryAfterSeconds ? <p>Wait at least {data.retryAfterSeconds} seconds before trying again.</p> : null}
  </>;
}
