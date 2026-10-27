export type Page =
  | 'home'
  | 'login'
  | 'register'
  | 'verify'
  | 'forgot'
  | 'reset'
  | 'watchlist'
  | 'tracker'
  | 'details'
  | 'notifications';

export type UiState =
  | 'normal'
  | 'loading'
  | 'empty'
  | 'validation'
  | 'expired'
  | 'unavailable'
  | 'unsupported'
  | 'unsupported-dlc'
  | 'unsupported-bundle'
  | 'unsupported-edition';
