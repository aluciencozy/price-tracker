import { createContext, useContext } from 'react';
export const ApiModeContext = createContext(false);
export const useApiMode = () => useContext(ApiModeContext);
