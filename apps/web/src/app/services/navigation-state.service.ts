import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class NavigationStateService {
  readonly hasSupplies = signal(false);

  setHasSupplies(value: boolean) {
    this.hasSupplies.set(value);
  }

  markSuppliesPresent() {
    this.hasSupplies.set(true);
  }

  reset() {
    this.hasSupplies.set(false);
  }
}
