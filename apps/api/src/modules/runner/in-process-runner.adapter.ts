import { Inject, Injectable } from '@nestjs/common';
import { EmbeddedRunnerService } from './embedded/embedded-runner.service';
import {
  AvailableModel,
  AvailableSkill,
  CancelTurnInput,
  CloseThreadInput,
  CodexRateLimits,
  CompactThreadInput,
  EnsureDirectoryInput,
  EnsureDirectoryResult,
  ForkThreadInput,
  ForkThreadResult,
  ModelListInput,
  ResolveTurnApprovalInput,
  RunnerAdapter,
  RunnerHealth,
  RunnerStreamEvent,
  SkillListInput,
  StartTurnInput,
  SteerTurnInput,
  WorkspaceFileContentInput,
  WorkspaceFileContentResult,
  WorkspaceFileInput,
  WorkspaceFileResult,
  WorkspaceSuggestionInput,
  WorkspaceTreeEntry,
  WorkspaceTreeInput,
  WorkspaceUploadInput,
  WorkspaceUploadResult,
} from './runner.types';

@Injectable()
export class InProcessRunnerAdapter implements RunnerAdapter {
  constructor(
    @Inject(EmbeddedRunnerService)
    private readonly embedded: EmbeddedRunnerService,
  ) {}

  startTurn(input: StartTurnInput): Promise<void> {
    return this.embedded.startTurn(input);
  }

  consumeTurnEvents(
    input: { turnId: string; sinceSeq?: number },
    onEvent: (event: RunnerStreamEvent) => Promise<void>,
  ): Promise<void> {
    return this.embedded.consumeTurnEvents(input, onEvent);
  }

  steerTurn(input: SteerTurnInput): Promise<void> {
    return this.embedded.steerTurn(input);
  }

  cancelTurn(input: CancelTurnInput): Promise<boolean> {
    return this.embedded.cancelTurn(input);
  }

  resetWorkers(): Promise<void> {
    return this.embedded.resetWorkers();
  }

  resolveTurnApproval(input: ResolveTurnApprovalInput): Promise<void> {
    return this.embedded.resolveTurnApproval(input);
  }

  readCodexRateLimits(): Promise<CodexRateLimits> {
    return this.embedded.readCodexRateLimits();
  }

  getHealth(): Promise<RunnerHealth> {
    return this.embedded.getHealth();
  }

  listModels(input: ModelListInput): Promise<AvailableModel[]> {
    return this.embedded.listModels(input);
  }

  listSkills(input: SkillListInput): Promise<AvailableSkill[]> {
    return this.embedded.listSkills(input);
  }

  forkThread(input: ForkThreadInput): Promise<ForkThreadResult> {
    return this.embedded.forkThread(input);
  }

  closeThread(input: CloseThreadInput): Promise<void> {
    return this.embedded.closeThread(input);
  }

  compactThread(input: CompactThreadInput): Promise<void> {
    return this.embedded.compactThread(input);
  }

  ensureDirectory(input: EnsureDirectoryInput): Promise<EnsureDirectoryResult> {
    return this.embedded.ensureDirectory(input);
  }

  suggestWorkspaceDirectories(input: WorkspaceSuggestionInput): Promise<string[]> {
    return this.embedded.suggestWorkspaceDirectories(input);
  }

  listWorkspaceTree(input: WorkspaceTreeInput): Promise<WorkspaceTreeEntry[]> {
    return this.embedded.listWorkspaceTree(input);
  }

  readWorkspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileResult> {
    return this.embedded.readWorkspaceFile(input);
  }

  readWorkspaceFileContent(input: WorkspaceFileContentInput): Promise<WorkspaceFileContentResult> {
    return this.embedded.readWorkspaceFileContent(input);
  }

  uploadWorkspaceFile(input: WorkspaceUploadInput): Promise<WorkspaceUploadResult> {
    return this.embedded.uploadWorkspaceFile(input);
  }
}
