/**
 * These tests covered the old direct-fetch RiotService implementation.
 * RiotService now delegates to RiotApiService which routes all calls through
 * Electron IPC (main process → twisted). Tests for the new implementation
 * belong in riot-api.service.spec.ts and require IPC mocks.
 */

import { TestBed } from '@angular/core/testing';
import { RiotService } from './riot.service';

describe('RiotService (delegate)', () => {
  it('should be created', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(RiotService);
    expect(service).toBeTruthy();
  });
});
