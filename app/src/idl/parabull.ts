/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/parabull.json`.
 */
export type Parabull = {
  "address": "8tBGLgWXDAssTBgUaamsB4ZbyRQivNDiGFiyTMfQiPFW",
  "metadata": {
    "name": "parabull",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Parabull bonding-curve launchpad: blind launches, ticker registry, 1% fee flywheel, Raydium CPMM graduation"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "docs": [
        "Nominee: accept the admin role."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "pendingAdmin",
          "signer": true
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "buy",
      "docs": [
        "Buy `amount` tokens for at most `max_sol_cost` lamports (fee inclusive).",
        "Partially fills to the curve's remaining tokens; the final fill completes it."
      ],
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "userTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "maxSolCost",
          "type": "u64"
        }
      ]
    },
    {
      "name": "buybackAndBurn",
      "docs": [
        "Crank: swap the staged SOL for $PARABULL on Raydium CPMM (enforcing",
        "`min_amount_out`) and burn everything received."
      ],
      "discriminator": [
        121,
        156,
        154,
        165,
        194,
        86,
        180,
        130
      ],
      "accounts": [
        {
          "name": "crank",
          "docs": [
            "Funds the temporary token accounts; refunded when they close."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "buybackAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "parabullMint",
          "writable": true
        },
        {
          "name": "parabullTokenProgram"
        },
        {
          "name": "authorityParabullAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "buybackAuthority"
              },
              {
                "kind": "account",
                "path": "parabullTokenProgram"
              },
              {
                "kind": "account",
                "path": "parabullMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "authorityWsolAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "buybackAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "cpmmProgram"
        },
        {
          "name": "cpmmAuthority"
        },
        {
          "name": "ammConfig"
        },
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "wsolVault",
          "writable": true
        },
        {
          "name": "parabullVault",
          "writable": true
        },
        {
          "name": "observationState",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "minAmountOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimHolderReward",
      "docs": [
        "Anyone: pay leaf `index` of `epoch` to its claimant (push or pull)."
      ],
      "discriminator": [
        51,
        163,
        15,
        252,
        248,
        154,
        190,
        46
      ],
      "accounts": [
        {
          "name": "holderVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "rewardEpoch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "arg",
                "path": "epoch"
              }
            ]
          }
        },
        {
          "name": "claimant",
          "docs": [
            "Recipient named in the Merkle leaf (system-owned wallet). Not a signer:",
            "anyone may submit the claim, funds can only go here."
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "epoch",
          "type": "u64"
        },
        {
          "name": "index",
          "type": "u32"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "collectLpFees",
      "docs": [
        "Crank: harvest post-graduation LP fees via the fee-key NFT and route the",
        "SOL (escrow first, then buyback / holder vaults / treasury)."
      ],
      "discriminator": [
        8,
        174,
        201,
        78,
        141,
        117,
        163,
        33
      ],
      "accounts": [
        {
          "name": "crank",
          "docs": [
            "Pays the temporary WSOL account's rent; refunded in the same instruction."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Writable: burning the collected tokens reduces the mint's supply."
          ],
          "writable": true
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "feeKeyVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  45,
                  107,
                  101,
                  121,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "feeVaultTokenAccount",
          "docs": [
            "Receives the launched-token side; burned and closed before the instruction ends."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "feeKeyVault"
              },
              {
                "kind": "account",
                "path": "token2022Program"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "feeVaultWsolAccount",
          "docs": [
            "Temporary WSOL receiver; closed (unwrapped) before the instruction ends."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "feeKeyVault"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "holderVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "lpLockProgram"
        },
        {
          "name": "lpLockAuthority"
        },
        {
          "name": "feeNftAccount",
          "writable": true
        },
        {
          "name": "lockedLiquidity",
          "writable": true
        },
        {
          "name": "cpmmProgram"
        },
        {
          "name": "cpmmAuthority"
        },
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "lpMint",
          "writable": true
        },
        {
          "name": "token0Vault",
          "writable": true
        },
        {
          "name": "token1Vault",
          "writable": true
        },
        {
          "name": "lockLpVault",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "memoProgram",
          "address": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feeLpAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "create",
      "docs": [
        "Blind launch. Signed by the launch authority and the fresh mint keypair;",
        "consumes the ticket, claims the ticker/name locks, creates the curve."
      ],
      "discriminator": [
        24,
        30,
        200,
        40,
        5,
        28,
        7,
        119
      ],
      "accounts": [
        {
          "name": "launchAuthority",
          "docs": [
            "Backend signer; fronts the rent and is repaid exactly that from the ticket."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "docs": [
            "Closed to the treasury at the end of the instruction: after the launch",
            "authority's rent is repaid, the fee and anything unspent go there."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "launchTicket"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "Ticket owner; recorded as the curve's creator."
          ],
          "writable": true,
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "mint",
          "docs": [
            "Fresh server-generated keypair; must sign. Holds no authority after this ix."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tickerRegistry",
          "docs": [
            "Created on first use; re-claimed only after its 3-day lock lapses."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "nameRegistry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  97,
                  109,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "ticket.name_hash",
                "account": "launchTicket"
              }
            ]
          }
        },
        {
          "name": "tweetRegistry",
          "docs": [
            "Required exactly when the ticket carries an announcement tweet."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  119,
                  101,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        }
      ]
    },
    {
      "name": "expireRewardEpoch",
      "docs": [
        "Crank or admin: after an epoch's claim window, stop its claims and",
        "release its unclaimed reservation back to the holder vault."
      ],
      "discriminator": [
        139,
        138,
        100,
        102,
        196,
        232,
        103,
        204
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The crank authority or the admin."
          ],
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "holderVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "rewardEpoch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "arg",
                "path": "epochIndex"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "epochIndex",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "One-time `Global` setup. Only the program's upgrade authority may call it,",
        "so deployment cannot be front-run."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "docs": [
            "Destination of swept buyback fees (SOL held as lamports above rent)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "holderVault",
          "docs": [
            "Destination of swept holder-reward fees."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "8tBGLgWXDAssTBgUaamsB4ZbyRQivNDiGFiyTMfQiPFW"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "globalParams"
            }
          }
        }
      ]
    },
    {
      "name": "lockMigratedLp",
      "docs": [
        "Graduation 3/3 (crank + fresh NFT mint keypair): lock all LP in Burn & Earn."
      ],
      "discriminator": [
        49,
        25,
        99,
        246,
        14,
        32,
        216,
        154
      ],
      "accounts": [
        {
          "name": "crank",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "migrationAuthority",
          "docs": [
            "LP owner and rent payer for the lock accounts (from the reserve)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  103,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "feeKeyVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  45,
                  107,
                  101,
                  121,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "feeNftMint",
          "docs": [
            "Fresh keypair generated by the crank; the lock program initialises it."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "lpLockProgram"
        },
        {
          "name": "lpLockAuthority"
        },
        {
          "name": "poolState"
        },
        {
          "name": "lpMint"
        },
        {
          "name": "creatorLpToken",
          "writable": true
        },
        {
          "name": "token0Vault",
          "writable": true
        },
        {
          "name": "token1Vault",
          "writable": true
        },
        {
          "name": "feeNftAccount",
          "writable": true
        },
        {
          "name": "lockedLiquidity",
          "writable": true
        },
        {
          "name": "lockLpVault",
          "writable": true
        },
        {
          "name": "nftMetadata",
          "writable": true
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "metadataProgram",
          "address": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
        }
      ],
      "args": []
    },
    {
      "name": "migrateRaydium",
      "docs": [
        "Graduation 2/3 (crank): create the Raydium CPMM pool."
      ],
      "discriminator": [
        198,
        96,
        158,
        2,
        114,
        87,
        180,
        1
      ],
      "accounts": [
        {
          "name": "crank",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Writable: unsolicited surplus tokens are burned."
          ],
          "writable": true
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "migrationAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  103,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "authorityTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "migrationAuthority"
              },
              {
                "kind": "account",
                "path": "token2022Program"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "authorityWsolAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "migrationAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "wsolMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "cpmmProgram"
        },
        {
          "name": "ammConfig"
        },
        {
          "name": "cpmmAuthority"
        },
        {
          "name": "poolState",
          "docs": [
            "keypair that signs this transaction (checked in the handler)."
          ],
          "writable": true
        },
        {
          "name": "canonicalPoolState",
          "docs": [
            "Read only to tell whether someone already created it."
          ]
        },
        {
          "name": "lpMint",
          "writable": true
        },
        {
          "name": "creatorLpToken",
          "writable": true
        },
        {
          "name": "token0Vault",
          "writable": true
        },
        {
          "name": "token1Vault",
          "writable": true
        },
        {
          "name": "createPoolFee",
          "writable": true
        },
        {
          "name": "observationState",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "prepareBuyback",
      "docs": [
        "Crank: stage `amount` lamports from BuybackVault for `buyback_and_burn`",
        "(send both in one transaction)."
      ],
      "discriminator": [
        127,
        177,
        47,
        169,
        245,
        67,
        106,
        84
      ],
      "accounts": [
        {
          "name": "crank",
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "buybackAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "prepareMigration",
      "docs": [
        "Graduation 1/3 (crank): move the curve's tokens + SOL to the migration authority."
      ],
      "discriminator": [
        59,
        118,
        102,
        18,
        9,
        133,
        23,
        172
      ],
      "accounts": [
        {
          "name": "crank",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Writable: unsolicited surplus tokens are burned."
          ],
          "writable": true
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "migrationAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  103,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "authorityTokenAccount",
          "docs": [
            "Becomes CPMM's `creator_token_*` for the launched mint."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "migrationAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "proposeAdmin",
      "docs": [
        "Admin: nominate a new admin (`Pubkey::default()` cancels)."
      ],
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "publishRewardEpoch",
      "docs": [
        "Crank: commit `total_lamports` of the holder vault to a snapshot Merkle root."
      ],
      "discriminator": [
        98,
        14,
        69,
        83,
        53,
        252,
        44,
        206
      ],
      "accounts": [
        {
          "name": "crank",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "holderVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "rewardEpoch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "holder_vault.next_epoch",
                "account": "holderRewardVault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "merkleRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "totalLamports",
          "type": "u64"
        },
        {
          "name": "numLeaves",
          "type": "u32"
        },
        {
          "name": "snapshotSlot",
          "type": "u64"
        }
      ]
    },
    {
      "name": "refundTicket",
      "docs": [
        "Return an unused ticket's deposit + rent to its payer. Payer: after",
        "expiry. Launch authority: any time (backend rejection)."
      ],
      "discriminator": [
        178,
        97,
        75,
        218,
        227,
        28,
        21,
        73
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The payer (after expiry) or the launch authority (any time)."
          ],
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "launchTicket"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "releaseDexEscrow",
      "docs": [
        "Pay a funded escrow (`dex_target_lamports`) to the treasury, once."
      ],
      "discriminator": [
        247,
        115,
        38,
        207,
        87,
        83,
        105,
        62
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "requestLaunch",
      "docs": [
        "User deposits `Global.ticket_deposit_lamports` and commits to the exact",
        "name/symbol/URI. `symbol` must be the canonical ticker.",
        "`tweet_id` (optional) is the numeric status ID of the announcement tweet."
      ],
      "discriminator": [
        194,
        49,
        100,
        76,
        25,
        25,
        76,
        233
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "tickerRegistry",
          "docs": [
            "may not exist yet (never launched), so it's derived and read in the",
            "handler: a ticket can't be bought for a ticker still in its lock."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        },
        {
          "name": "tweetId",
          "type": {
            "option": "u64"
          }
        }
      ]
    },
    {
      "name": "sell",
      "docs": [
        "Sell `amount` tokens for at least `min_sol_output` lamports (net of fee)."
      ],
      "discriminator": [
        51,
        230,
        133,
        164,
        1,
        127,
        131,
        173
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "userTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "minSolOutput",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Admin: emergency pause (launches, trading, buybacks, new reward epochs)."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "sweepFees",
      "docs": [
        "Move buyback / holder / treasury buckets to their vaults (never the escrow)."
      ],
      "discriminator": [
        175,
        225,
        98,
        71,
        118,
        66,
        34,
        148
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "holderVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "topUpDexEscrow",
      "docs": [
        "Anyone can add protocol fees to a curve's DexScreener escrow, up to the target."
      ],
      "discriminator": [
        61,
        135,
        174,
        248,
        89,
        170,
        132,
        72
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateGlobalParams",
      "docs": [
        "Admin: partial `Global` update, validated as a whole."
      ],
      "discriminator": [
        146,
        36,
        222,
        108,
        89,
        226,
        249,
        126
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "update",
          "type": {
            "defined": {
              "name": "globalUpdate"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "bondingCurve",
      "discriminator": [
        23,
        183,
        248,
        55,
        96,
        216,
        172,
        96
      ]
    },
    {
      "name": "buybackVault",
      "discriminator": [
        153,
        166,
        71,
        144,
        179,
        189,
        137,
        251
      ]
    },
    {
      "name": "global",
      "discriminator": [
        167,
        232,
        232,
        177,
        200,
        108,
        114,
        127
      ]
    },
    {
      "name": "holderRewardVault",
      "discriminator": [
        226,
        191,
        43,
        79,
        146,
        8,
        189,
        140
      ]
    },
    {
      "name": "launchTicket",
      "discriminator": [
        235,
        200,
        179,
        207,
        226,
        242,
        244,
        161
      ]
    },
    {
      "name": "nameRegistry",
      "discriminator": [
        169,
        63,
        83,
        240,
        198,
        158,
        53,
        11
      ]
    },
    {
      "name": "rewardEpoch",
      "discriminator": [
        214,
        103,
        106,
        97,
        14,
        4,
        33,
        156
      ]
    },
    {
      "name": "tickerRegistry",
      "discriminator": [
        179,
        120,
        101,
        250,
        243,
        117,
        178,
        237
      ]
    },
    {
      "name": "tweetRegistry",
      "discriminator": [
        12,
        194,
        241,
        83,
        239,
        106,
        27,
        57
      ]
    }
  ],
  "events": [
    {
      "name": "adminTransferProposed",
      "discriminator": [
        203,
        168,
        175,
        51,
        239,
        104,
        20,
        85
      ]
    },
    {
      "name": "adminTransferred",
      "discriminator": [
        255,
        147,
        182,
        5,
        199,
        217,
        38,
        179
      ]
    },
    {
      "name": "buybackBurned",
      "discriminator": [
        186,
        84,
        241,
        202,
        152,
        185,
        0,
        115
      ]
    },
    {
      "name": "buybackStaged",
      "discriminator": [
        66,
        102,
        77,
        204,
        41,
        16,
        89,
        5
      ]
    },
    {
      "name": "dexEscrowReleased",
      "discriminator": [
        224,
        87,
        5,
        197,
        206,
        21,
        240,
        102
      ]
    },
    {
      "name": "dexEscrowToppedUp",
      "discriminator": [
        175,
        161,
        244,
        114,
        168,
        200,
        41,
        103
      ]
    },
    {
      "name": "epochExpired",
      "discriminator": [
        100,
        30,
        119,
        234,
        71,
        13,
        47,
        170
      ]
    },
    {
      "name": "feesSwept",
      "discriminator": [
        96,
        218,
        115,
        136,
        74,
        170,
        202,
        172
      ]
    },
    {
      "name": "globalParamsUpdated",
      "discriminator": [
        212,
        96,
        46,
        152,
        150,
        242,
        177,
        48
      ]
    },
    {
      "name": "graduationReady",
      "discriminator": [
        225,
        53,
        28,
        227,
        76,
        125,
        195,
        142
      ]
    },
    {
      "name": "holderRewardClaimed",
      "discriminator": [
        38,
        51,
        8,
        24,
        30,
        110,
        96,
        202
      ]
    },
    {
      "name": "launchRequested",
      "discriminator": [
        182,
        25,
        247,
        28,
        152,
        144,
        12,
        50
      ]
    },
    {
      "name": "liquidityLocked",
      "discriminator": [
        150,
        201,
        204,
        183,
        217,
        13,
        119,
        185
      ]
    },
    {
      "name": "lpFeesCollected",
      "discriminator": [
        208,
        126,
        62,
        199,
        117,
        158,
        108,
        232
      ]
    },
    {
      "name": "migratedToRaydium",
      "discriminator": [
        34,
        204,
        182,
        221,
        253,
        2,
        1,
        28
      ]
    },
    {
      "name": "migrationPrepared",
      "discriminator": [
        34,
        222,
        38,
        134,
        134,
        231,
        82,
        228
      ]
    },
    {
      "name": "pauseToggled",
      "discriminator": [
        105,
        215,
        89,
        53,
        198,
        232,
        136,
        161
      ]
    },
    {
      "name": "rewardEpochPublished",
      "discriminator": [
        210,
        4,
        41,
        48,
        209,
        206,
        81,
        194
      ]
    },
    {
      "name": "ticketRefunded",
      "discriminator": [
        46,
        173,
        213,
        43,
        145,
        205,
        132,
        218
      ]
    },
    {
      "name": "tokenCreated",
      "discriminator": [
        236,
        19,
        41,
        255,
        130,
        78,
        147,
        172
      ]
    },
    {
      "name": "tradeEvent",
      "discriminator": [
        189,
        219,
        127,
        211,
        78,
        230,
        97,
        238
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6001,
      "name": "divisionByZero",
      "msg": "Division by zero"
    },
    {
      "code": 6002,
      "name": "truncation",
      "msg": "Value does not fit in u64"
    },
    {
      "code": 6003,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6004,
      "name": "insufficientReserves",
      "msg": "Requested amount exceeds curve reserves"
    },
    {
      "code": 6005,
      "name": "unauthorized",
      "msg": "Signer is not authorised for this action"
    },
    {
      "code": 6006,
      "name": "paused",
      "msg": "Program is paused"
    },
    {
      "code": 6007,
      "name": "platformFeeTooHigh",
      "msg": "Platform fee exceeds the 1% ceiling"
    },
    {
      "code": 6008,
      "name": "feeSplitOutOfRange",
      "msg": "Buyback + holder basis points exceed 10000"
    },
    {
      "code": 6009,
      "name": "ticketDepositTooLow",
      "msg": "Launch ticket deposit does not cover the launch fee plus rent buffer"
    },
    {
      "code": 6010,
      "name": "invalidDuration",
      "msg": "Invalid duration parameter"
    },
    {
      "code": 6011,
      "name": "invalidCurveParams",
      "msg": "Invalid bonding curve parameters"
    },
    {
      "code": 6012,
      "name": "invalidAuthority",
      "msg": "A required authority or mint is the default pubkey"
    },
    {
      "code": 6013,
      "name": "invalidTicker",
      "msg": "Ticker must be 1-10 ASCII letters or digits"
    },
    {
      "code": 6014,
      "name": "invalidName",
      "msg": "Name must be 1-32 bytes"
    },
    {
      "code": 6015,
      "name": "invalidUri",
      "msg": "URI exceeds 200 bytes"
    },
    {
      "code": 6016,
      "name": "nonCanonicalSymbol",
      "msg": "Symbol must already be the canonical ticker (uppercase A-Z/0-9, no $ or spaces)"
    },
    {
      "code": 6017,
      "name": "nonCanonicalName",
      "msg": "Name must not have leading or trailing whitespace"
    },
    {
      "code": 6018,
      "name": "ticketExpired",
      "msg": "Launch ticket has expired"
    },
    {
      "code": 6019,
      "name": "ticketNotExpired",
      "msg": "Launch ticket has not expired yet"
    },
    {
      "code": 6020,
      "name": "launchFeeExceedsDeposit",
      "msg": "Launch fee exceeds the ticket deposit"
    },
    {
      "code": 6021,
      "name": "metadataMismatch",
      "msg": "Name/symbol/URI do not match the launch ticket commitment"
    },
    {
      "code": 6022,
      "name": "tickerLocked",
      "msg": "Ticker is locked by a launch in the last 3 days"
    },
    {
      "code": 6023,
      "name": "nameLocked",
      "msg": "Name is locked by a launch in the last 3 days"
    },
    {
      "code": 6024,
      "name": "tradingNotOpenYet",
      "msg": "Trading has not opened yet for this curve"
    },
    {
      "code": 6025,
      "name": "curveComplete",
      "msg": "Bonding curve is complete; trading is locked until migration"
    },
    {
      "code": 6026,
      "name": "slippageExceeded",
      "msg": "Slippage limit exceeded"
    },
    {
      "code": 6027,
      "name": "lamportInvariantViolated",
      "msg": "Bonding curve lamports do not cover rent + reserves + accrued fees"
    },
    {
      "code": 6028,
      "name": "curveNotComplete",
      "msg": "Bonding curve is not complete"
    },
    {
      "code": 6029,
      "name": "invalidMigrationStage",
      "msg": "Migration is not at the required stage"
    },
    {
      "code": 6030,
      "name": "invalidMigrationAccount",
      "msg": "Account does not match the derived Raydium/migration address"
    },
    {
      "code": 6031,
      "name": "insufficientMigrationSol",
      "msg": "Curve SOL does not exceed the migration reserve"
    },
    {
      "code": 6032,
      "name": "migrationPriceOutOfRange",
      "msg": "Opening pool price deviates too far from the curve's final price"
    },
    {
      "code": 6033,
      "name": "invalidMigrationParams",
      "msg": "Invalid migration parameters"
    },
    {
      "code": 6034,
      "name": "escrowNotFunded",
      "msg": "DexScreener escrow has not reached the target"
    },
    {
      "code": 6035,
      "name": "escrowAlreadyFunded",
      "msg": "DexScreener escrow is already funded"
    },
    {
      "code": 6036,
      "name": "escrowAlreadyReleased",
      "msg": "DexScreener escrow was already released"
    },
    {
      "code": 6037,
      "name": "noPendingAdmin",
      "msg": "No admin transfer is pending for this signer"
    },
    {
      "code": 6038,
      "name": "nothingCollected",
      "msg": "Nothing was collected"
    },
    {
      "code": 6039,
      "name": "buybackNotConfigured",
      "msg": "$PARABULL buyback pool is not configured"
    },
    {
      "code": 6040,
      "name": "insufficientVaultBalance",
      "msg": "Vault cannot pay this amount and stay rent-exempt"
    },
    {
      "code": 6041,
      "name": "insufficientRewardFunds",
      "msg": "Holder vault cannot fund this epoch on top of outstanding rewards"
    },
    {
      "code": 6042,
      "name": "invalidRewardEpoch",
      "msg": "Invalid holder-reward epoch parameters"
    },
    {
      "code": 6043,
      "name": "invalidMerkleProof",
      "msg": "Merkle proof does not match the epoch root"
    },
    {
      "code": 6044,
      "name": "rewardAlreadyClaimed",
      "msg": "Reward already claimed"
    },
    {
      "code": 6045,
      "name": "rewardEpochExhausted",
      "msg": "Claim exceeds the epoch's remaining total"
    },
    {
      "code": 6046,
      "name": "rewardEpochExpired",
      "msg": "Reward epoch has expired"
    },
    {
      "code": 6047,
      "name": "rewardEpochNotExpired",
      "msg": "Reward epoch claim window has not ended"
    },
    {
      "code": 6048,
      "name": "invalidTweetId",
      "msg": "Tweet ID must be a non-zero X/Twitter status ID"
    },
    {
      "code": 6049,
      "name": "tweetLocked",
      "msg": "Announcement tweet is locked by a launch in the last 3 days"
    },
    {
      "code": 6050,
      "name": "tweetRegistryMismatch",
      "msg": "Tweet registry account must be passed exactly when the ticket has a tweet"
    },
    {
      "code": 6051,
      "name": "tradingDelayOutOfRange",
      "msg": "Trading open delay must be between 1 and 150 slots"
    },
    {
      "code": 6052,
      "name": "dexTargetTooHigh",
      "msg": "DexScreener escrow target exceeds the maximum"
    },
    {
      "code": 6053,
      "name": "migrationReserveOutOfRange",
      "msg": "Migration reserve must leave the pool priced within the allowed discount of the curve's final price"
    },
    {
      "code": 6054,
      "name": "canonicalPoolTaken",
      "msg": "The canonical CPMM pool already exists: migrate into a fresh-address pool"
    },
    {
      "code": 6055,
      "name": "freshPoolNotAllowed",
      "msg": "A fresh-address pool is only allowed when the canonical CPMM pool already exists"
    },
    {
      "code": 6056,
      "name": "tickerRegistryMismatch",
      "msg": "Ticker registry account does not match the ticker"
    }
  ],
  "types": [
    {
      "name": "adminTransferProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "adminTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previousAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "bondingCurve",
      "docs": [
        "Per-token curve. PDA: `[\"bonding-curve\", mint]`.",
        "",
        "Lamport invariant: `lamports >= rent_exempt_min + real_sol_reserves + accrued_fees()`.",
        "Fees are tallied here (not pushed to shared vaults) so trades on different",
        "tokens never write-lock a common account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "complete",
            "docs": [
              "Real token reserves hit zero; trading stops, awaiting migration."
            ],
            "type": "bool"
          },
          {
            "name": "migrated",
            "docs": [
              "Liquidity seeded into Raydium CPMM and LP locked."
            ],
            "type": "bool"
          },
          {
            "name": "escrowReleased",
            "docs": [
              "DexScreener escrow paid out; later fees skip Stage 1."
            ],
            "type": "bool"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "docs": [
              "Wallet that paid the launch ticket. Earns 0% of trading fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "type": "u64"
          },
          {
            "name": "createdSlot",
            "type": "u64"
          },
          {
            "name": "tradingOpenSlot",
            "docs": [
              "No buy/sell before this slot."
            ],
            "type": "u64"
          },
          {
            "name": "launchTimestamp",
            "type": "i64"
          },
          {
            "name": "escrowAccrued",
            "docs": [
              "Fee buckets (lamports held in this account until swept)."
            ],
            "type": "u64"
          },
          {
            "name": "buybackAccrued",
            "type": "u64"
          },
          {
            "name": "holderAccrued",
            "type": "u64"
          },
          {
            "name": "treasuryAccrued",
            "type": "u64"
          },
          {
            "name": "migrationStage",
            "docs": [
              "`MigrationStage` as u8."
            ],
            "type": "u8"
          },
          {
            "name": "migrationSol",
            "docs": [
              "Amounts moved to the migration authority by `prepare_migration`."
            ],
            "type": "u64"
          },
          {
            "name": "migrationTokens",
            "type": "u64"
          },
          {
            "name": "raydiumPool",
            "docs": [
              "Raydium CPMM pool created by `migrate_raydium`."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeNftMint",
            "docs": [
              "Burn & Earn fee-key NFT mint created by `lock_migrated_lp`."
            ],
            "type": "pubkey"
          },
          {
            "name": "lpFeesSolCollected",
            "docs": [
              "Lifetime post-graduation LP fees: SOL collected and launched tokens",
              "collected-and-burned (measured amounts)."
            ],
            "type": "u64"
          },
          {
            "name": "lpFeesTokensBurned",
            "type": "u64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          }
        ]
      }
    },
    {
      "name": "buybackBurned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "parabullMint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "solIn",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "minAmountOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "buybackStaged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "vaultRemaining",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "buybackVault",
      "docs": [
        "Program-owned SOL for $PARABULL buyback & burn. PDA: `[\"buyback-vault\"]`.",
        "SOL is held as this account's lamports above rent."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "totalDepositedLamports",
            "type": "u64"
          },
          {
            "name": "totalSpentLamports",
            "type": "u64"
          },
          {
            "name": "totalTokensBurned",
            "type": "u64"
          },
          {
            "name": "buybackCount",
            "type": "u64"
          },
          {
            "name": "lastBuybackAt",
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "dexEscrowReleased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "excessToBuyback",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "dexEscrowToppedUp",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "accepted",
            "type": "u64"
          },
          {
            "name": "escrowAccrued",
            "type": "u64"
          },
          {
            "name": "target",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "epochExpired",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epochIndex",
            "type": "u64"
          },
          {
            "name": "reclaimedLamports",
            "docs": [
              "Unclaimed lamports released back to the vault's available balance."
            ],
            "type": "u64"
          },
          {
            "name": "expiredBy",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "feesSwept",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "toBuybackVault",
            "type": "u64"
          },
          {
            "name": "toHolderVault",
            "type": "u64"
          },
          {
            "name": "toTreasury",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "global",
      "docs": [
        "Singleton config. PDA: `[\"global\"]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "admin",
            "docs": [
              "Config + emergency authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "launchAuthority",
            "docs": [
              "Backend signer that must co-sign every `create` (blind launch)."
            ],
            "type": "pubkey"
          },
          {
            "name": "crankAuthority",
            "docs": [
              "Backend signer for migrate / escrow release / buyback / holder epochs."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "docs": [
              "Receives launch fees, released DexScreener escrow and treasury fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "parabullMint",
            "docs": [
              "Native $PARABULL mint (buyback target, holder-reward eligibility)."
            ],
            "type": "pubkey"
          },
          {
            "name": "launchFeeLamports",
            "docs": [
              "Protocol launch fee carved out of each ticket (0.2 SOL)."
            ],
            "type": "u64"
          },
          {
            "name": "ticketDepositLamports",
            "docs": [
              "Total a user deposits into a `LaunchTicket` (~0.23 SOL)."
            ],
            "type": "u64"
          },
          {
            "name": "ticketTtlSeconds",
            "docs": [
              "After this many seconds an unconsumed ticket is refundable."
            ],
            "type": "i64"
          },
          {
            "name": "platformFeeBps",
            "docs": [
              "Platform trading fee, hard-capped at `MAX_PLATFORM_FEE_BPS` (1%)."
            ],
            "type": "u16"
          },
          {
            "name": "buybackBps",
            "docs": [
              "Post-escrow split of the platform fee; remainder goes to treasury."
            ],
            "type": "u16"
          },
          {
            "name": "holderBps",
            "type": "u16"
          },
          {
            "name": "dexTargetLamports",
            "docs": [
              "DexScreener listing target in lamports (admin-updated from SOL/USD)."
            ],
            "type": "u64"
          },
          {
            "name": "dexTargetUpdatedAt",
            "type": "i64"
          },
          {
            "name": "tradingOpenDelaySlots",
            "docs": [
              "Slots between creation and the first allowed trade (anti block-zero)."
            ],
            "type": "u64"
          },
          {
            "name": "registryLockSeconds",
            "docs": [
              "Ticker/name lock window (3 days)."
            ],
            "type": "i64"
          },
          {
            "name": "initialVirtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "initialVirtualSolReserves",
            "type": "u64"
          },
          {
            "name": "initialRealTokenReserves",
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "type": "u64"
          },
          {
            "name": "launchCount",
            "type": "u64"
          },
          {
            "name": "cpmmProgram",
            "docs": [
              "Raydium CPMM program (mainnet `CPMMoo8L…`), configurable per cluster."
            ],
            "type": "pubkey"
          },
          {
            "name": "cpmmAmmConfig",
            "docs": [
              "CPMM `AmmConfig` (fee tier) new pools are created under."
            ],
            "type": "pubkey"
          },
          {
            "name": "lpLockProgram",
            "docs": [
              "Raydium Burn & Earn LP-lock program and its authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "lpLockAuthority",
            "type": "pubkey"
          },
          {
            "name": "migrationReserveLamports",
            "docs": [
              "SOL held back from the pool to pay Raydium fees and rent."
            ],
            "type": "u64"
          },
          {
            "name": "pendingAdmin",
            "docs": [
              "Two-step admin transfer: set by `propose_admin`, cleared by `accept_admin`."
            ],
            "type": "pubkey"
          },
          {
            "name": "parabullPool",
            "docs": [
              "Raydium CPMM WSOL/$PARABULL pool used by `buyback_and_burn`",
              "(`Pubkey::default()` until the pool exists)."
            ],
            "type": "pubkey"
          },
          {
            "name": "rewardClaimWindowSeconds",
            "docs": [
              "Claim window copied into each reward epoch at publish time."
            ],
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                24
              ]
            }
          }
        ]
      }
    },
    {
      "name": "globalParams",
      "docs": [
        "Admin-settable parameters, validated as a unit."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "launchAuthority",
            "type": "pubkey"
          },
          {
            "name": "crankAuthority",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "parabullMint",
            "type": "pubkey"
          },
          {
            "name": "launchFeeLamports",
            "type": "u64"
          },
          {
            "name": "ticketDepositLamports",
            "type": "u64"
          },
          {
            "name": "ticketTtlSeconds",
            "type": "i64"
          },
          {
            "name": "platformFeeBps",
            "type": "u16"
          },
          {
            "name": "buybackBps",
            "type": "u16"
          },
          {
            "name": "holderBps",
            "type": "u16"
          },
          {
            "name": "dexTargetLamports",
            "type": "u64"
          },
          {
            "name": "tradingOpenDelaySlots",
            "type": "u64"
          },
          {
            "name": "registryLockSeconds",
            "type": "i64"
          },
          {
            "name": "initialVirtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "initialVirtualSolReserves",
            "type": "u64"
          },
          {
            "name": "initialRealTokenReserves",
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "type": "u64"
          },
          {
            "name": "cpmmProgram",
            "type": "pubkey"
          },
          {
            "name": "cpmmAmmConfig",
            "type": "pubkey"
          },
          {
            "name": "lpLockProgram",
            "type": "pubkey"
          },
          {
            "name": "lpLockAuthority",
            "type": "pubkey"
          },
          {
            "name": "migrationReserveLamports",
            "type": "u64"
          },
          {
            "name": "parabullPool",
            "docs": [
              "May be default at initialize; required only by `buyback_and_burn`."
            ],
            "type": "pubkey"
          },
          {
            "name": "rewardClaimWindowSeconds",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "globalParamsUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "update",
            "type": {
              "defined": {
                "name": "globalUpdate"
              }
            }
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "globalUpdate",
      "docs": [
        "Partial update for `update_global_params`: `None` leaves a field unchanged.",
        "The merged result is validated with the same rules as `initialize`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dexTargetLamports",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "buybackBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "holderBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "migrationReserveLamports",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "tradingOpenDelaySlots",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "cpmmProgram",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "cpmmAmmConfig",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "lpLockProgram",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "lpLockAuthority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "parabullMint",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "parabullPool",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "rewardClaimWindowSeconds",
            "type": {
              "option": "i64"
            }
          }
        ]
      }
    },
    {
      "name": "graduationReady",
      "docs": [
        "The last real token was bought; the curve is locked until Raydium migration."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "bondingCurve",
            "type": "pubkey"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "escrowAccrued",
            "type": "u64"
          },
          {
            "name": "escrowFunded",
            "type": "bool"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "holderRewardClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "index",
            "type": "u32"
          },
          {
            "name": "claimant",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "holderRewardVault",
      "docs": [
        "Program-owned SOL for $PARABULL holder rewards. PDA: `[\"holder-vault\"]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "totalDepositedLamports",
            "type": "u64"
          },
          {
            "name": "totalCommittedLamports",
            "docs": [
              "Lamports committed to published epochs (claimable or claimed)."
            ],
            "type": "u64"
          },
          {
            "name": "totalClaimedLamports",
            "type": "u64"
          },
          {
            "name": "nextEpoch",
            "docs": [
              "Next epoch index to publish."
            ],
            "type": "u64"
          },
          {
            "name": "totalExpiredLamports",
            "docs": [
              "Unclaimed lamports released by `expire_reward_epoch`."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                56
              ]
            }
          }
        ]
      }
    },
    {
      "name": "launchRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "ticker",
            "type": "string"
          },
          {
            "name": "nameHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "metadataHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "depositLamports",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "tweetIdHash",
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "launchTicket",
      "docs": [
        "User-funded launch request. PDA: `[\"ticket\", payer, nonce_le]`.",
        "",
        "The payer commits to the exact metadata; the backend can only consume the",
        "ticket with matching metadata, or the payer refunds after `expires_at`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "depositLamports",
            "docs": [
              "Everything the user paid: the flat deposit, *including* this ticket's",
              "own rent (the ticket holds exactly this many lamports)."
            ],
            "type": "u64"
          },
          {
            "name": "launchFeeLamports",
            "docs": [
              "Protocol fee quoted at request time. The rest of the deposit repays",
              "the rent the launch authority fronts in `create`; anything unspent",
              "goes to the treasury."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "ticker",
            "type": {
              "array": [
                "u8",
                10
              ]
            }
          },
          {
            "name": "tickerLen",
            "type": "u8"
          },
          {
            "name": "nameHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "metadataHash",
            "docs": [
              "`metadata_commitment(name, symbol, uri)`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tweetIdHash",
            "docs": [
              "`launch::tweet_id_hash(tweet_id)` of the announcement tweet, if any.",
              "Computed on-chain from the numeric status ID so URL variants of one",
              "tweet can't dodge the lock."
            ],
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                24
              ]
            }
          }
        ]
      }
    },
    {
      "name": "liquidityLocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "lpAmount",
            "type": "u64"
          },
          {
            "name": "feeNftMint",
            "type": "pubkey"
          },
          {
            "name": "feeNftOwner",
            "type": "pubkey"
          },
          {
            "name": "reserveRefundedToTreasury",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "lpFeesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "feeLpAmount",
            "type": "u64"
          },
          {
            "name": "solCollected",
            "docs": [
              "Measured SOL actually received (unwrapped from WSOL)."
            ],
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "docs": [
              "Measured launched-token amount received, burned in the same instruction."
            ],
            "type": "u64"
          },
          {
            "name": "toEscrow",
            "type": "u64"
          },
          {
            "name": "toBuybackVault",
            "type": "u64"
          },
          {
            "name": "toHolderVault",
            "type": "u64"
          },
          {
            "name": "toTreasury",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "migratedToRaydium",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "lpMint",
            "type": "pubkey"
          },
          {
            "name": "token0",
            "type": "pubkey"
          },
          {
            "name": "token1",
            "type": "pubkey"
          },
          {
            "name": "tokensToPool",
            "type": "u64"
          },
          {
            "name": "solToPool",
            "type": "u64"
          },
          {
            "name": "surplusTokensBurned",
            "docs": [
              "Unsolicited tokens found in the migration authority's account, burned."
            ],
            "type": "u64"
          },
          {
            "name": "surplusWsol",
            "docs": [
              "Unsolicited WSOL in the migration authority's account; follows the",
              "unspent reserve to the treasury in `lock_migrated_lp`."
            ],
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "migrationPrepared",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "migrationAuthority",
            "type": "pubkey"
          },
          {
            "name": "solToPool",
            "type": "u64"
          },
          {
            "name": "solReserve",
            "type": "u64"
          },
          {
            "name": "tokensToPool",
            "type": "u64"
          },
          {
            "name": "surplusTokensBurned",
            "docs": [
              "Unsolicited tokens found in the curve's token account, burned."
            ],
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "nameRegistry",
      "docs": [
        "Name lock. PDA: `[\"name\", sha256(normalized_name)]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "nameHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "launchTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pauseToggled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "rewardEpoch",
      "docs": [
        "One holder-reward distribution: an off-chain snapshot of $PARABULL holders",
        "committed as a Merkle root over `(index, claimant, amount)` leaves.",
        "PDA: `[\"reward-epoch\", epoch_le]`. Sized per epoch for its claimed-bitmap."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "snapshotSlot",
            "type": "u64"
          },
          {
            "name": "totalLamports",
            "type": "u64"
          },
          {
            "name": "claimedLamports",
            "type": "u64"
          },
          {
            "name": "numLeaves",
            "type": "u32"
          },
          {
            "name": "claimedCount",
            "type": "u32"
          },
          {
            "name": "publishedAt",
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "`published_at + Global.reward_claim_window_seconds` at publish time."
            ],
            "type": "i64"
          },
          {
            "name": "expired",
            "docs": [
              "Set by `expire_reward_epoch`; no claims afterwards."
            ],
            "type": "bool"
          },
          {
            "name": "claimedBitmap",
            "docs": [
              "Bit `i` set once leaf `i` has been paid."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "rewardEpochPublished",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "totalLamports",
            "type": "u64"
          },
          {
            "name": "numLeaves",
            "type": "u32"
          },
          {
            "name": "snapshotSlot",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "tickerRegistry",
      "docs": [
        "Ticker lock. PDA: `[\"registry\", normalized_ticker]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "ticker",
            "type": {
              "array": [
                "u8",
                10
              ]
            }
          },
          {
            "name": "tickerLen",
            "type": "u8"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "launchTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ticketRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "refundedBy",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "bondingCurve",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
          },
          {
            "name": "createdSlot",
            "type": "u64"
          },
          {
            "name": "tradingOpenSlot",
            "type": "u64"
          },
          {
            "name": "launchTimestamp",
            "type": "i64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "type": "u64"
          },
          {
            "name": "launchFeeLamports",
            "type": "u64"
          },
          {
            "name": "rentReimbursed",
            "docs": [
              "Rent the launch authority fronted for this create, repaid from the ticket."
            ],
            "type": "u64"
          },
          {
            "name": "treasuryReceived",
            "docs": [
              "Launch fee plus any unspent operational allocation."
            ],
            "type": "u64"
          },
          {
            "name": "tweetIdHash",
            "docs": [
              "Announcement tweet locked for this launch, if any."
            ],
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "tradeEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "isBuy",
            "type": "bool"
          },
          {
            "name": "tokenAmount",
            "type": "u64"
          },
          {
            "name": "solAmount",
            "docs": [
              "Buy: lamports added to reserves. Sell: lamports removed from reserves."
            ],
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "feeToEscrow",
            "type": "u64"
          },
          {
            "name": "feeToBuyback",
            "type": "u64"
          },
          {
            "name": "feeToHolders",
            "type": "u64"
          },
          {
            "name": "feeToTreasury",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "tweetRegistry",
      "docs": [
        "Announcement-tweet lock. PDA: `[\"tweet\", tweet_id_hash]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tweetIdHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "launchTimestamp",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
