# React Native Offline Sync

![React Native](https://img.shields.io/badge/React_Native-0.72-61DAFB?style=flat-square&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

Offline-first data synchronization for React Native. Queue operations while offline, sync when connected, handle conflicts automatically.

## Features

- **Offline Queue** - Queue mutations while offline
- **Auto Sync** - Sync when connection restored
- **Conflict Resolution** - Last-write-wins or custom strategies
- **Optimistic Updates** - Instant UI feedback
- **Retry Logic** - Exponential backoff
- **Persistence** - Survives app restart

## Installation

```bash
npm install @marwantech/react-native-offline-sync
```

## Quick Start

```typescript
import { OfflineSync } from '@marwantech/react-native-offline-sync';

const sync = new OfflineSync({
  storage: AsyncStorage,
  onSync: async (operations) => {
    // Send to your API
    return api.syncBatch(operations);
  },
});

// Queue operation (works offline)
await sync.push({
  type: 'CREATE_TODO',
  payload: { id: '1', title: 'Buy milk', completed: false },
});

// Check pending operations
const pending = await sync.getPending();
console.log(`${pending.length} operations waiting to sync`);
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   App Actions   │────►│  Offline Queue   │────►│   Server    │
│  (optimistic)   │     │  (persistent)    │     │   API       │
└─────────────────┘     └──────────────────┘     └─────────────┘
        │                        │                      │
        │                        ▼                      │
        │               ┌──────────────────┐           │
        └──────────────►│  Local State     │◄──────────┘
                        │  (SQLite/MMKV)   │
                        └──────────────────┘
```

## Configuration

```typescript
const sync = new OfflineSync({
  // Required: Storage adapter
  storage: AsyncStorage,

  // Required: Sync handler
  onSync: async (operations) => {
    const results = await api.syncBatch(operations);
    return results; // Return server responses
  },

  // Optional: Conflict resolution
  onConflict: async (local, server) => {
    // Return 'local', 'server', or merged data
    return server.updatedAt > local.updatedAt ? 'server' : 'local';
  },

  // Optional: Retry configuration
  retry: {
    maxAttempts: 5,
    backoff: 'exponential', // 'fixed' | 'exponential'
    initialDelay: 1000,
    maxDelay: 30000,
  },

  // Optional: Batch configuration
  batch: {
    size: 50,           // Max operations per sync
    debounce: 1000,     // Wait before syncing
  },

  // Optional: Hooks
  onOnline: () => console.log('Back online!'),
  onOffline: () => console.log('Gone offline'),
  onSyncStart: () => showSpinner(),
  onSyncComplete: (results) => hideSpinner(),
  onSyncError: (error) => showError(error),
});
```

## Operations

### Push Operation

```typescript
// Create
await sync.push({
  type: 'CREATE',
  entity: 'todos',
  payload: { id: uuid(), title: 'New todo', completed: false },
});

// Update
await sync.push({
  type: 'UPDATE',
  entity: 'todos',
  id: 'todo-123',
  payload: { completed: true },
});

// Delete
await sync.push({
  type: 'DELETE',
  entity: 'todos',
  id: 'todo-123',
});
```

### Manual Sync

```typescript
// Force sync now
await sync.syncNow();

// Check sync status
const status = sync.getStatus();
// { isOnline: true, isSyncing: false, pending: 3, lastSync: Date }
```

### Clear Queue

```typescript
// Clear all pending operations
await sync.clearPending();

// Clear specific operation
await sync.remove(operationId);
```

## Conflict Resolution

### Built-in Strategies

```typescript
import { ConflictStrategy } from '@marwantech/react-native-offline-sync';

const sync = new OfflineSync({
  conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
  // or: SERVER_WINS, CLIENT_WINS, MANUAL
});
```

### Custom Resolution

```typescript
const sync = new OfflineSync({
  onConflict: async (localOp, serverData) => {
    // Show UI for user to resolve
    const choice = await showConflictDialog({
      local: localOp.payload,
      server: serverData,
    });

    if (choice === 'local') return localOp.payload;
    if (choice === 'server') return serverData;
    return choice.merged; // User merged manually
  },
});
```

### Field-Level Merge

```typescript
const sync = new OfflineSync({
  onConflict: async (local, server) => {
    // Merge at field level
    return {
      ...server,
      // Keep local changes for specific fields
      title: local.payload.title ?? server.title,
      // Use server for timestamps
      updatedAt: server.updatedAt,
    };
  },
});
```

## React Integration

### Context Provider

```typescript
import { OfflineSyncProvider, useOfflineSync } from '@marwantech/react-native-offline-sync';

function App() {
  return (
    <OfflineSyncProvider config={syncConfig}>
      <TodoApp />
    </OfflineSyncProvider>
  );
}

function TodoList() {
  const { push, isOnline, isSyncing, pending } = useOfflineSync();

  const addTodo = async (title: string) => {
    const todo = { id: uuid(), title, completed: false };

    // Optimistic update
    setTodos(prev => [...prev, todo]);

    // Queue sync operation
    await push({
      type: 'CREATE',
      entity: 'todos',
      payload: todo,
    });
  };

  return (
    <View>
      {!isOnline && <OfflineBanner />}
      {pending > 0 && <Text>{pending} changes pending</Text>}
      {isSyncing && <ActivityIndicator />}
      {/* ... */}
    </View>
  );
}
```

### Optimistic Updates Hook

```typescript
import { useOptimistic } from '@marwantech/react-native-offline-sync';

function TodoItem({ todo }) {
  const { execute, isPending, error } = useOptimistic();

  const toggleComplete = () => {
    execute({
      // Optimistic update (immediate)
      optimistic: () => {
        updateLocalTodo(todo.id, { completed: !todo.completed });
      },
      // Server operation (queued)
      operation: {
        type: 'UPDATE',
        entity: 'todos',
        id: todo.id,
        payload: { completed: !todo.completed },
      },
      // Rollback on failure
      rollback: () => {
        updateLocalTodo(todo.id, { completed: todo.completed });
      },
    });
  };

  return (
    <TouchableOpacity onPress={toggleComplete} style={isPending && styles.pending}>
      <Checkbox checked={todo.completed} />
      <Text>{todo.title}</Text>
    </TouchableOpacity>
  );
}
```

## Network Detection

```typescript
import { useNetworkStatus } from '@marwantech/react-native-offline-sync';

function NetworkBanner() {
  const { isOnline, connectionType } = useNetworkStatus();

  if (isOnline) return null;

  return (
    <View style={styles.banner}>
      <Text>You're offline. Changes will sync when connected.</Text>
    </View>
  );
}
```

## Persistence

Operations persist across app restarts:

```typescript
// Using AsyncStorage (default)
import AsyncStorage from '@react-native-async-storage/async-storage';

const sync = new OfflineSync({
  storage: AsyncStorage,
  storageKey: '@offline_sync_queue', // Custom key
});

// Using MMKV (faster)
import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();
const sync = new OfflineSync({
  storage: {
    getItem: (key) => mmkv.getString(key) ?? null,
    setItem: (key, value) => mmkv.set(key, value),
    removeItem: (key) => mmkv.delete(key),
  },
});
```

## Error Handling

```typescript
const sync = new OfflineSync({
  onSyncError: (error, operation) => {
    if (error.status === 409) {
      // Conflict - handle separately
      return 'retry';
    }
    if (error.status >= 500) {
      // Server error - retry later
      return 'retry';
    }
    // Client error - discard operation
    return 'discard';
  },
});
```

## License

MIT
