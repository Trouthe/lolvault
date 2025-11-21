import { Component, inject } from '@angular/core';
import { signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AccCardComponent } from '../../components/acc-card/acc-card.component';
import { AddAccountModalComponent } from '../../components/modals/add-account-modal/add-account-modal.component';
import { SettingsModalComponent } from '../../components/modals/settings-modal/settings-modal.component';
import { Account } from '../../models/interfaces/Account';
import { RiotService } from '../../services/riot.service';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AccCardComponent,
    AddAccountModalComponent,
    SettingsModalComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  public accounts = signal<Account[]>([]);
  public isModalOpen = signal(false);
  public isSettingsOpen = signal(false);
  private _searchQuery = signal('');
  public searchQuery = '';
  public championId = signal<string>('');

  private riotService = inject(RiotService);
  public settingsService = inject(SettingsService);

  // Computed property for filtered accounts
  public filteredAccounts = computed(() => {
    const query = this._searchQuery().toLowerCase().trim();
    if (!query) {
      return this.accounts();
    }

    return this.accounts().filter(
      (account) =>
        account.name?.toLowerCase().includes(query) ||
        account.username?.toLowerCase().includes(query) ||
        account.server?.toLowerCase().includes(query) ||
        account.rank?.toLowerCase().includes(query) ||
        account.game?.toLowerCase().includes(query)
    );
  });

  updateSearch() {
    this._searchQuery.set(this.searchQuery);
  }

  constructor() {
    this.loadAccounts();
  }

  async loadAccounts() {
    try {
      const loadedAccounts = await window.electronAPI.loadAccounts();
      let needsUpdate = false;

      // Process accounts and fetch fresh Riot data
      const updatedAccounts = await Promise.all(
        loadedAccounts.map(async (account) => {
          // Check if NAME contains '#' AND server is set before running Riot checks
          if (account.name && account.name.includes('#') && account.server) {
            // If account ID is a PUUID (string), we already have it
            const accountPuuid =
              typeof account.id === 'string' && account.id.length > 20 ? account.id : null;

            // Only fetch PUUID if we don't have it (convert old accounts)
            if (!accountPuuid) {
              const [summonerId, tagline] = account.name.split('#');
              console.log(
                `Fetching PUUID for: ${summonerId}#${tagline} on server ${account.server}`
              );

              try {
                const puuid = await this.riotService.getPUUID(summonerId, tagline, account.server);
                account.id = puuid; // Use PUUID as the account ID
                console.log(`Got PUUID: ${puuid}`);
                needsUpdate = true;
              } catch (error) {
                console.error(`Error fetching PUUID for ${account.name}:`, error);
                return account;
              }
            }

            // Get the PUUID to use
            const puuidToUse =
              typeof account.id === 'string' && account.id.length > 20 ? account.id : null;

            // Fetch FRESH data every time (profile icon, mastery, and rank)
            if (puuidToUse) {
              try {
                // Get basic account info for profile icon
                const basicInfo = await this.riotService.getBasicAccountInfo(
                  puuidToUse,
                  account.server
                );
                account.profileIconId = basicInfo.profileIconId;
                console.log(`Got profile icon: ${basicInfo.profileIconId}`);

                // Get top mastery champions
                const masteryData = await this.riotService.getTopMasteryChampions(
                  puuidToUse,
                  account.server
                );
                if (masteryData && masteryData.length > 0) {
                  const topChampion = masteryData.reduce((prev, current) =>
                    current.championLevel > prev.championLevel ? current : prev
                  );
                  account.topChampionId = topChampion.championId.toString();
                  console.log(
                    `Top champion ID: ${account.topChampionId} (Level ${topChampion.championLevel})`
                  );
                }

                // Get ranked info and update rank
                const rankedInfo = await this.riotService.getRankedInfo(puuidToUse, account.server);
                if (rankedInfo && rankedInfo.length > 0) {
                  const soloQueue = rankedInfo.find(
                    (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
                  );
                  if (soloQueue) {
                    const newRank = `${soloQueue.tier} ${soloQueue.rank}`;
                    if (account.rank !== newRank) {
                      account.rank = newRank;
                      needsUpdate = true;
                      console.log(`Updated rank to: ${newRank}`);
                    }
                  }
                } else {
                  // Clear rank if unranked
                  if (account.rank) {
                    account.rank = undefined;
                    needsUpdate = true;
                    console.log('Account is unranked, cleared rank');
                  }
                }
              } catch (error) {
                console.error(`Error fetching Riot data for ${account.name}:`, error);
              }
            }
          }

          return account;
        })
      );

      this.accounts.set(updatedAccounts);

      if (needsUpdate) {
        console.log('Saving cleaned accounts...');
        // Create a clean copy without profileIconId and topChampionId for saving
        const accountsToSave = updatedAccounts.map((acc) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { profileIconId, topChampionId, ...cleanAccount } = acc;
          return cleanAccount;
        });
        await window.electronAPI.saveAccounts(accountsToSave);
      }

      // Calculate mastery background
      this.updateMasteryBackground();
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  }

  private async updateMasteryBackground() {
    const accounts = this.accounts();
    const accountWithMastery = accounts.find((acc) => acc.topChampionId);

    if (accountWithMastery && accountWithMastery.topChampionId) {
      try {
        const champions = await import('../../data/champions.json');
        const championData = champions.data;

        // Find champion key from championId
        const championEntry = Object.entries(championData).find(
          ([, champ]) => champ.key === accountWithMastery.topChampionId
        );

        if (championEntry) {
          this.championId.set(championEntry[1].id);
          console.log('Mastery background champion set to:', championEntry[1].id);
        }
      } catch (error) {
        console.error('Error loading champion data:', error);
      }
    }
  }

  addAccount(): void {
    this.isModalOpen.set(true);
  }

  closeModal(): void {
    this.isModalOpen.set(false);
  }

  openSettings(): void {
    this.isSettingsOpen.set(true);
  }

  closeSettings(): void {
    this.isSettingsOpen.set(false);
  }

  onSearchChange(query: string): void {
    this._searchQuery.set(query);
  }

  async onAccountsAdded(newAccounts: Account[]): Promise<void> {
    // Fetch Riot data for new accounts with taglines AND server
    const processedAccounts = await Promise.all(
      newAccounts.map(async (account) => {
        // Check if NAME contains '#' AND server is set
        if (account.name && account.name.includes('#') && account.server) {
          const [summonerId, tagline] = account.name.split('#');
          console.log(`Fetching Riot data for new account: ${summonerId}#${tagline}`);

          try {
            // Get PUUID and use it as the account ID (if not already set)
            if (!account.id || typeof account.id === 'number') {
              const puuid = await this.riotService.getPUUID(summonerId, tagline, account.server);
              account.id = puuid; // Use PUUID as the account ID ONLY
              console.log(`Got PUUID: ${puuid}`);
            }

            const puuidToUse = typeof account.id === 'string' ? account.id : '';

            // Get FRESH data for display (NOT SAVED to disk)
            const basicInfo = await this.riotService.getBasicAccountInfo(
              puuidToUse,
              account.server
            );
            account.profileIconId = basicInfo.profileIconId;
            console.log(`Got profile icon: ${basicInfo.profileIconId}`);

            // Get top mastery champions (NOT SAVED to disk)
            const masteryData = await this.riotService.getTopMasteryChampions(
              puuidToUse,
              account.server
            );
            if (masteryData && masteryData.length > 0) {
              const topChampion = masteryData.reduce((prev, current) =>
                current.championLevel > prev.championLevel ? current : prev
              );
              account.topChampionId = topChampion.championId.toString();
              console.log(`Top champion ID: ${account.topChampionId}`);
            }

            // Rank is already fetched by the modal, but verify/update if needed
            if (!account.rank) {
              const rankedInfo = await this.riotService.getRankedInfo(puuidToUse, account.server);
              if (rankedInfo && rankedInfo.length > 0) {
                const soloQueue = rankedInfo.find(
                  (q: { queueType: string }) => q.queueType === 'RANKED_SOLO_5x5'
                );
                if (soloQueue) {
                  account.rank = `${soloQueue.tier} ${soloQueue.rank}`;
                  console.log(`Fetched rank: ${account.rank}`);
                }
              }
            }
          } catch (error) {
            console.error(`Error fetching Riot data for ${account.name}:`, error);
            // Keep the original timestamp-based ID if Riot fetch fails
          }
        }
        return account;
      })
    );

    // Update the signal FIRST before saving (this prevents refresh glitch)
    const updatedAccounts = [...this.accounts(), ...processedAccounts];
    this.accounts.set(updatedAccounts);

    // Save to disk WITHOUT profileIconId and topChampionId
    try {
      const accountsToSave = updatedAccounts.map((acc) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { profileIconId, topChampionId, ...cleanAccount } = acc;
        return cleanAccount;
      });
      const result = await window.electronAPI.saveAccounts(accountsToSave);
      if (result.success) {
        console.log('Accounts saved successfully');
        // Update mastery background after adding new accounts
        this.updateMasteryBackground();
      } else {
        console.error('Error saving accounts:', result.error);
      }
    } catch (error) {
      console.error('Error saving accounts:', error);
    }
  }

  async onAccountUpdated(updatedAccount: Account): Promise<void> {
    const currentAccounts = this.accounts();
    const updatedAccounts = currentAccounts.map((acc) =>
      acc.id === updatedAccount.id ? updatedAccount : acc
    );
    this.accounts.set(updatedAccounts);

    try {
      // Save WITHOUT profileIconId and topChampionId
      const accountsToSave = updatedAccounts.map((acc) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { profileIconId, topChampionId, ...cleanAccount } = acc;
        return cleanAccount;
      });
      const result = await window.electronAPI.saveAccounts(accountsToSave);
      if (result.success) {
        console.log('Account updated successfully');
      } else {
        console.error('Error updating account:', result.error);
      }
    } catch (error) {
      console.error('Error updating account:', error);
    }
  }

  async onAccountDeleted(deletedAccount: Account): Promise<void> {
    const currentAccounts = this.accounts();
    const updatedAccounts = currentAccounts.filter((acc) => acc.id !== deletedAccount.id);
    this.accounts.set(updatedAccounts);

    try {
      // Save WITHOUT profileIconId and topChampionId
      const accountsToSave = updatedAccounts.map((acc) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { profileIconId, topChampionId, ...cleanAccount } = acc;
        return cleanAccount;
      });
      const result = await window.electronAPI.saveAccounts(accountsToSave);
      if (result.success) {
        console.log('Account deleted successfully');
      } else {
        console.error('Error deleting account:', result.error);
      }
    } catch (error) {
      console.error('Error deleting account:', error);
    }
  }
}
