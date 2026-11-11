# Third-party notices

This repository's own code is under the MIT License in [LICENSE](LICENSE). It
uses the third-party software below. None of it is copied into the repository;
package managers and the setup steps download it.

## Bundled into the G2 app (`g2/dist`, `*.ehpk`)

`pnpm --dir g2 run build` and `pnpm --dir g2 run pack` bundle these packages. If
you redistribute a built package, keep their copyright and license notices with it.

| Package | Version | License | Notice |
| --- | --- | --- | --- |
| `@evenrealities/even_hub_sdk` | 0.0.16 | MIT | Copyright (c) 2025 Yangshun Tay (as stated in the package's `LICENSE`) |
| `@evenrealities/pretext` | 0.1.4 | MIT (declared in its `package.json`) | Even Realities |
| `vite` client helpers | 6.x | MIT | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors |

## Used by the relay at run time

| Package | Version | License |
| --- | --- | --- |
| `ws` | 8 | MIT, Copyright (c) 2011 Einar Otto Stangvik and contributors |

## Development tools, not redistributed

| Tool | License |
| --- | --- |
| `@evenrealities/evenhub-cli` | No license is declared in its npm package. It is installed from npm as a dev dependency and is not distributed by this repository |
| `@evenrealities/evenhub-simulator` | MIT |
| `typescript`, `@types/node`, `@types/ws` | Apache-2.0 / MIT |

## Speech recognition (`asr/`, downloaded into the ignored `vendor/` folder)

| Component | License |
| --- | --- |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) v1.9.5 | MIT, Copyright (c) 2023-2024 The ggml authors |
| Whisper large-v3-turbo weights (ggml conversion) | MIT, OpenAI |
| [Silero VAD](https://github.com/snakers4/silero-vad) v5.1.2 | MIT |

## Applications and services this project talks to

Grok Bot, Even Realities G2, the Even Realities app, Even Hub, and Tailscale are
products of their respective owners. This project is not affiliated with or
endorsed by any of them. You need your own copies and accounts, under their own
terms.
