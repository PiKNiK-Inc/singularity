export interface GetReplicationsResponseItem {
    id: string,
    datasetId: string,
    replica: number,
    criteria: string,
    client: string,
    maxNumberOfDeals: number,
    status: 'active' | 'paused' | 'completed' | 'error',
    cronSchedule?: string,
    cronMaxDeals?: number,
    errorMessage?: string,
    replicationCompleted: number,
    replicationActive: number,
    replicationPaused: number,
    replicationTotal: number,
    replicationError: number
  }

export type GetReplicationsResponse = GetReplicationsResponseItem[];
