import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { VERSION, REVISION } from '../environments/version';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  version = [VERSION, REVISION];
  title = 'lolvault';
}
