import { Injectable } from '@angular/core';
import { initializePaddle, type Paddle } from '@paddle/paddle-js';

@Injectable({
  providedIn: 'root',
})
export class PaddleService {
  private paddle: Paddle | undefined;

  async init(): Promise<void> {
    this.paddle = await initializePaddle({
      environment: 'sandbox',
      token: 'test_e78426f32ebd58d410e9cb2c0bb',
    })
      .then((paddle) => {
        console.log('Paddle initialized successfully');
        return paddle;
      })
      .catch((error) => {
        console.error('Error initializing Paddle:', error);
        return undefined;
      });
  }

  openCheckout(priceId: string): void {
    this.paddle?.Checkout.open({
      items: [{ priceId, quantity: 1 }],
    });
  }
}
