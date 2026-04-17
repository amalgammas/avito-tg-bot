import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from './api.service';
import { NavigationStateService } from './navigation-state.service';

interface SessionResponse {
  authenticated: boolean;
  user: { id: string; email: string };
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly navigationState = inject(NavigationStateService);
  private readonly userState = signal<SessionResponse['user'] | null>(null);
  private readonly checkedState = signal(false);

  readonly user = computed(() => this.userState());
  readonly checked = computed(() => this.checkedState());
  readonly authenticated = computed(() => Boolean(this.userState()));

  async ensureSession(): Promise<boolean> {
    if (this.checkedState()) {
      return this.authenticated();
    }

    try {
      const response = await firstValueFrom(this.api.get<SessionResponse>('/api/auth/session'));
      this.userState.set(response.user);
      this.checkedState.set(true);
      return true;
    } catch {
      this.userState.set(null);
      this.checkedState.set(true);
      return false;
    }
  }

  async requestMagicLink(email: string) {
    return firstValueFrom(
      this.api.post<{ delivery: 'resend' | 'log'; previewUrl?: string }>('/api/auth/request-magic-link', { email }),
    );
  }

  async verifyMagicLink(token: string) {
    const response = await firstValueFrom(
      this.api.post<{ user: SessionResponse['user'] }>('/api/auth/verify-magic-link', { token }),
    );
    this.userState.set(response.user);
    this.checkedState.set(true);
    return response;
  }

  async logout() {
    await firstValueFrom(this.api.post('/api/auth/logout', {}));
    this.userState.set(null);
    this.checkedState.set(true);
    this.navigationState.reset();
    await this.router.navigateByUrl('/login');
  }
}
