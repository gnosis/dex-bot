export type Command = () => void
export interface WatchOrderPlacementParams {
  // TODO: Try to use instead of "any" the autogenerated type from the ABI (data from the event)
  onNewOrder: (data: any) => void
  onError: (error: Error) => void
}

export interface DfusionRepo {
  // Watch events
  watchOrderPlacement(params: WatchOrderPlacementParams): void

  // Basic info
  getNetworkId(): Promise<number>
  getNodeInfo(): Promise<String>
  getBlockNumber(): Promise<number>
}
