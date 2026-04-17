import { Routes } from '@angular/router';

import { authGuard } from './services/auth.guard';
import { AppLayoutComponent } from './layout/app-layout.component';
import { DashboardPageComponent } from './pages/dashboard-page.component';
import { LoginPageComponent } from './pages/login-page.component';
import { SettingsPageComponent } from './pages/settings-page.component';
import { SupplyDetailPageComponent } from './pages/supply-detail-page.component';
import { SuppliesPageComponent } from './pages/supplies-page.component';
import { SupplyWizardPageComponent } from './pages/supply-wizard-page.component';
import { VerifyLoginPageComponent } from './pages/verify-login-page.component';

export const appRoutes: Routes = [
  { path: 'login', component: LoginPageComponent },
  { path: 'login/verify', component: VerifyLoginPageComponent },
  {
    path: '',
    component: AppLayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: DashboardPageComponent },
      { path: 'supplies', component: SuppliesPageComponent },
      { path: 'supplies/new', component: SupplyWizardPageComponent },
      { path: 'supplies/:id', component: SupplyDetailPageComponent },
      { path: 'settings', component: SettingsPageComponent },
    ],
  },
  { path: '**', redirectTo: '' },
];
