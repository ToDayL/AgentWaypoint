import { ConflictException } from '@nestjs/common';

// Shared with Session/Project deletion, without introducing an AI/terminal DI cycle.
export class TerminalLifecycle {
  private readonly locks = new Map<string, Promise<unknown>>();
  readonly resources = new Map<
    string,
    {
      projectId: string;
      sessionId: string;
      state: string;
      dispose: () => void;
    }
  >();

  async withProject<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(projectId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(projectId) === current) this.locks.delete(projectId);
    }
  }

  assertDeletable(projectId: string, sessionId?: string): void {
    const ids = [...this.resources]
      .filter(
        ([, terminal]) =>
          terminal.projectId === projectId &&
          (!sessionId || terminal.sessionId === sessionId) &&
          ['starting', 'running', 'closing'].includes(terminal.state),
      )
      .map(([id]) => id);
    if (ids.length)
      throw new ConflictException({
        message: 'Close active terminal tabs before deleting this session/project',
        details: { code: 'TERMINALS_ACTIVE', terminalIds: ids },
      });
  }

  discard(projectId: string, sessionId?: string): void {
    for (const [id, terminal] of this.resources) {
      if (terminal.projectId === projectId && (!sessionId || terminal.sessionId === sessionId)) {
        terminal.dispose();
        this.resources.delete(id);
      }
    }
  }
}

export const terminalLifecycle = new TerminalLifecycle();
