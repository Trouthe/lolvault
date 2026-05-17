import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { map, take } from 'rxjs/operators';
import { AuthService } from './services/auth.service';

const redirectLoggedInFromAuth: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.currentUser$.pipe(
    take(1),
    map((user) => (user ? router.createUrlTree(['/dashboard']) : true))
  );
};

const redirectLoggedOutFromDashboard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.currentUser$.pipe(
    take(1),
    map((user) => (user ? true : router.createUrlTree(['/'])))
  );
};

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home.component').then((m) => m.HomeComponent),
  },
  {
    path: 'auth',
    canActivate: [redirectLoggedInFromAuth],
    loadComponent: () => import('./pages/auth/auth.component').then((m) => m.AuthComponent),
  },
  {
    path: 'dashboard',
    canActivate: [redirectLoggedOutFromDashboard],
    loadComponent: () =>
      import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
];
