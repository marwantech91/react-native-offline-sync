import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

interface Operation {
  id: string;
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  entity: string;
  payload?: Record<string, unknown>;
  entityId?: string;
  timestamp: number;
  attempts: number;
}

interface StorageAdapter {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
}

interface RetryConfig {
  maxAttempts: number;
  backoff: 'fixed' | 'exponential';
  initialDelay: number;
  maxDelay: number;
}

interface BatchConfig {
  size: number;
  debounce: number;
}

type ConflictResolution = 'local' | 'server' | Record<string, unknown>;

interface SyncResult {
  operationId: string;
  success: boolean;
  serverData?: Record<string, unknown>;
  error?: Error;
}

interface OfflineSyncOptions {
  storage: StorageAdapter;
  storageKey?: string;
  onSync: (operations: Operation[]) => Promise<SyncResult[]>;
  onConflict?: (local: Operation, server: Record<string, unknown>) => Promise<ConflictResolution>;
  conflictStrategy?: 'LAST_WRITE_WINS' | 'SERVER_WINS' | 'CLIENT_WINS' | 'MANUAL';
  retry?: Partial<RetryConfig>;
  batch?: Partial<BatchConfig>;
  onOnline?: () => void;
  onOffline?: () => void;
  onSyncStart?: () => void;
  onSyncComplete?: (results: SyncResult[]) => void;
  onSyncError?: (error: Error, operation: Operation) => 'retry' | 'discard';
}

interface SyncStatus {
  isOnline: boolean;
  isSyncing: boolean;
  pending: number;
  lastSync: Date | null;
}

export const ConflictStrategy = {
  LAST_WRITE_WINS: 'LAST_WRITE_WINS',
  SERVER_WINS: 'SERVER_WINS',
  CLIENT_WINS: 'CLIENT_WINS',
  MANUAL: 'MANUAL',
} as const;

export class OfflineSync {
  private storage: StorageAdapter;
  private storageKey: string;
  private queue: Operation[] = [];
  private isOnline = true;
  private isSyncing = false;
  private lastSync: Date | null = null;
  private syncTimeout: NodeJS.Timeout | null = null;
  private unsubscribeNetInfo: (() => void) | null = null;

  private onSync: (operations: Operation[]) => Promise<SyncResult[]>;
  private onConflict?: (local: Operation, server: Record<string, unknown>) => Promise<ConflictResolution>;
  private retry: RetryConfig;
  private batch: BatchConfig;
  private hooks: {
    onOnline?: () => void;
    onOffline?: () => void;
    onSyncStart?: () => void;
    onSyncComplete?: (results: SyncResult[]) => void;
    onSyncError?: (error: Error, operation: Operation) => 'retry' | 'discard';
  };

  constructor(options: OfflineSyncOptions) {
    this.storage = options.storage;
    this.storageKey = options.storageKey || '@offline_sync_queue';
    this.onSync = options.onSync;
    this.onConflict = options.onConflict;

    this.retry = {
      maxAttempts: 5,
      backoff: 'exponential',
      initialDelay: 1000,
      maxDelay: 30000,
      ...options.retry,
    };

    this.batch = {
      size: 50,
      debounce: 1000,
      ...options.batch,
    };

    this.hooks = {
      onOnline: options.onOnline,
      onOffline: options.onOffline,
      onSyncStart: options.onSyncStart,
      onSyncComplete: options.onSyncComplete,
      onSyncError: options.onSyncError,
    };

    this.init();
  }

  private async init(): Promise<void> {
    // Load persisted queue
    await this.loadQueue();

    // Monitor network status
    this.unsubscribeNetInfo = NetInfo.addEventListener(this.handleNetworkChange);

    // Check initial state
    const state = await NetInfo.fetch();
    this.isOnline = state.isConnected ?? false;

    // Sync if online and have pending
    if (this.isOnline && this.queue.length > 0) {
      this.scheduleSync();
    }
  }

  private handleNetworkChange = (state: NetInfoState): void => {
    const wasOffline = !this.isOnline;
    this.isOnline = state.isConnected ?? false;

    if (this.isOnline && wasOffline) {
      this.hooks.onOnline?.();
      this.scheduleSync();
    } else if (!this.isOnline) {
      this.hooks.onOffline?.();
    }
  };

  async push(operation: Omit<Operation, 'id' | 'timestamp' | 'attempts'>): Promise<string> {
    const op: Operation = {
      ...operation,
      id: this.generateId(),
      timestamp: Date.now(),
      attempts: 0,
    };

    this.queue.push(op);
    await this.persistQueue();

    if (this.isOnline) {
      this.scheduleSync();
    }

    return op.id;
  }

  async getPending(): Promise<Operation[]> {
    return [...this.queue];
  }

  async remove(operationId: string): Promise<boolean> {
    const index = this.queue.findIndex(op => op.id === operationId);
    if (index === -1) return false;

    this.queue.splice(index, 1);
    await this.persistQueue();
    return true;
  }

  async clearPending(): Promise<void> {
    this.queue = [];
    await this.persistQueue();
  }

  getStatus(): SyncStatus {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pending: this.queue.length,
      lastSync: this.lastSync,
    };
  }

  async getOperationsByEntity(entity: string): Promise<Operation[]> {
    return this.queue.filter((op) => op.entity === entity);
  }

  async syncNow(): Promise<SyncResult[]> {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    return this.performSync();
  }

  private scheduleSync(): void {
    if (this.syncTimeout) return;

    this.syncTimeout = setTimeout(() => {
      this.syncTimeout = null;
      this.performSync();
    }, this.batch.debounce);
  }

  private async performSync(): Promise<SyncResult[]> {
    if (this.isSyncing || !this.isOnline || this.queue.length === 0) {
      return [];
    }

    this.isSyncing = true;
    this.hooks.onSyncStart?.();

    const batch = this.queue.slice(0, this.batch.size);
    const results: SyncResult[] = [];

    try {
      const syncResults = await this.onSync(batch);

      for (const result of syncResults) {
        const operation = batch.find(op => op.id === result.operationId);
        if (!operation) continue;

        if (result.success) {
          // Remove from queue
          await this.remove(operation.id);
          results.push(result);
        } else if (result.serverData && this.onConflict) {
          // Handle conflict
          const resolution = await this.onConflict(operation, result.serverData);
          if (resolution === 'server') {
            await this.remove(operation.id);
          } else if (resolution === 'local') {
            operation.attempts++;
            await this.persistQueue();
          } else {
            // Merged data - update operation
            operation.payload = resolution;
            await this.persistQueue();
          }
          results.push(result);
        } else {
          // Handle error
          operation.attempts++;

          if (operation.attempts >= this.retry.maxAttempts) {
            const action = this.hooks.onSyncError?.(result.error!, operation) ?? 'discard';
            if (action === 'discard') {
              await this.remove(operation.id);
            }
          }

          await this.persistQueue();
          results.push(result);
        }
      }

      this.lastSync = new Date();
      this.hooks.onSyncComplete?.(results);

      // Continue syncing if more pending
      if (this.queue.length > 0) {
        this.scheduleSync();
      }
    } catch (error) {
      console.error('Sync failed:', error);
    } finally {
      this.isSyncing = false;
    }

    return results;
  }

  private async loadQueue(): Promise<void> {
    try {
      const data = await this.storage.getItem(this.storageKey);
      if (data) {
        this.queue = JSON.parse(data);
      }
    } catch {
      this.queue = [];
    }
  }

  private async persistQueue(): Promise<void> {
    await this.storage.setItem(this.storageKey, JSON.stringify(this.queue));
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  destroy(): void {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
    this.unsubscribeNetInfo?.();
  }
}

// React Context
interface OfflineSyncContextValue extends SyncStatus {
  push: (operation: Omit<Operation, 'id' | 'timestamp' | 'attempts'>) => Promise<string>;
  syncNow: () => Promise<SyncResult[]>;
  clearPending: () => Promise<void>;
}

const OfflineSyncContext = createContext<OfflineSyncContextValue | null>(null);

export function useOfflineSync(): OfflineSyncContextValue {
  const context = useContext(OfflineSyncContext);
  if (!context) {
    throw new Error('useOfflineSync must be used within OfflineSyncProvider');
  }
  return context;
}

// Network status hook
export function useNetworkStatus(): { isOnline: boolean; connectionType: string | null } {
  const [status, setStatus] = useState({ isOnline: true, connectionType: null as string | null });

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setStatus({
        isOnline: state.isConnected ?? false,
        connectionType: state.type,
      });
    });

    return unsubscribe;
  }, []);

  return status;
}

// Optimistic update hook
interface UseOptimisticOptions<T> {
  optimistic: () => void;
  operation: Omit<Operation, 'id' | 'timestamp' | 'attempts'>;
  rollback: () => void;
}

export function useOptimistic<T>() {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const sync = useOfflineSync();

  const execute = useCallback(async (options: UseOptimisticOptions<T>) => {
    setIsPending(true);
    setError(null);

    // Apply optimistic update immediately
    options.optimistic();

    try {
      await sync.push(options.operation);
    } catch (err) {
      options.rollback();
      setError(err as Error);
    } finally {
      setIsPending(false);
    }
  }, [sync]);

  return { execute, isPending, error };
}

export default OfflineSync;
export type { Operation, SyncResult, SyncStatus, OfflineSyncOptions };
