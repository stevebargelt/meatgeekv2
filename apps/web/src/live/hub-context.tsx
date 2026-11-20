import { createContext, useContext, type ReactNode } from 'react';
import { createSignalRHub, type HubFactory } from './hub';

const HubFactoryContext = createContext<HubFactory>(createSignalRHub);

/** Replaces the real SignalR connection; tests pass a fake hub factory. */
export function HubFactoryProvider({
  createHub,
  children,
}: {
  createHub: HubFactory;
  children: ReactNode;
}) {
  return <HubFactoryContext.Provider value={createHub}>{children}</HubFactoryContext.Provider>;
}

export function useHubFactory(): HubFactory {
  return useContext(HubFactoryContext);
}
