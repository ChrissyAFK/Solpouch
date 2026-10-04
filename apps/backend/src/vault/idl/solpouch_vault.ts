/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/solpouch_vault.json`.
 */
export type SolpouchVault = {
  "address": "AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F",
  "metadata": {
    "name": "solpouchVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Budget-envelope vault: owner funds pouches, an agent key can only pay within on-chain limits"
  },
  "instructions": [
    {
      "name": "closePouch",
      "discriminator": [
        245,
        201,
        5,
        235,
        249,
        159,
        41,
        196
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "pouch"
          ]
        },
        {
          "name": "pouch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pouch.owner",
                "account": "pouch"
              },
              {
                "kind": "account",
                "path": "pouch.name",
                "account": "pouch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pouch"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createPouch",
      "discriminator": [
        106,
        201,
        195,
        19,
        74,
        225,
        59,
        248
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "pouch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "name"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pouch"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "maxPerOrder",
          "type": "u64"
        },
        {
          "name": "dailyLimit",
          "type": "u64"
        },
        {
          "name": "allowedMerchants",
          "type": {
            "vec": "pubkey"
          }
        }
      ]
    },
    {
      "name": "freeze",
      "discriminator": [
        255,
        91,
        207,
        84,
        251,
        194,
        254,
        63
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "pouch"
          ]
        },
        {
          "name": "pouch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pouch.owner",
                "account": "pouch"
              },
              {
                "kind": "account",
                "path": "pouch.name",
                "account": "pouch"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "pay",
      "discriminator": [
        119,
        18,
        216,
        65,
        192,
        117,
        122,
        220
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true,
          "signer": true,
          "relations": [
            "pouch"
          ]
        },
        {
          "name": "pouch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pouch.owner",
                "account": "pouch"
              },
              {
                "kind": "account",
                "path": "pouch.name",
                "account": "pouch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pouch"
              }
            ]
          }
        },
        {
          "name": "merchantToken",
          "docs": [
            "Must be the canonical ATA of an allowlisted merchant (checked in the handler)."
          ],
          "writable": true
        },
        {
          "name": "receipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pouch"
              },
              {
                "kind": "arg",
                "path": "orderId"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
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
          "name": "orderId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "setRules",
      "discriminator": [
        66,
        148,
        196,
        43,
        232,
        210,
        174,
        169
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "pouch"
          ]
        },
        {
          "name": "pouch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pouch.owner",
                "account": "pouch"
              },
              {
                "kind": "account",
                "path": "pouch.name",
                "account": "pouch"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "maxPerOrder",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "dailyLimit",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "allowedMerchants",
          "type": {
            "option": {
              "vec": "pubkey"
            }
          }
        }
      ]
    },
    {
      "name": "topUp",
      "discriminator": [
        236,
        225,
        96,
        9,
        60,
        106,
        77,
        208
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "pouch"
          ]
        },
        {
          "name": "pouch",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pouch.owner",
                "account": "pouch"
              },
              {
                "kind": "account",
                "path": "pouch.name",
                "account": "pouch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pouch"
              }
            ]
          }
        },
        {
          "name": "ownerToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
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
      "name": "unfreeze",
      "discriminator": [
        133,
        160,
        68,
        253,
        80,
        232,
        218,
        247
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "pouch"
          ]
        },
        {
          "name": "pouch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pouch.owner",
                "account": "pouch"
              },
              {
                "kind": "account",
                "path": "pouch.name",
                "account": "pouch"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "pouch"
          ]
        },
        {
          "name": "pouch",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  117,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pouch.owner",
                "account": "pouch"
              },
              {
                "kind": "account",
                "path": "pouch.name",
                "account": "pouch"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pouch"
              }
            ]
          }
        },
        {
          "name": "ownerToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "pouch",
      "discriminator": [
        1,
        68,
        34,
        227,
        194,
        225,
        66,
        255
      ]
    },
    {
      "name": "receipt",
      "discriminator": [
        39,
        154,
        73,
        106,
        80,
        102,
        145,
        153
      ]
    }
  ],
  "events": [
    {
      "name": "frozen",
      "discriminator": [
        115,
        77,
        189,
        83,
        81,
        71,
        245,
        232
      ]
    },
    {
      "name": "paymentMade",
      "discriminator": [
        227,
        251,
        123,
        16,
        133,
        220,
        83,
        242
      ]
    },
    {
      "name": "pouchClosed",
      "discriminator": [
        7,
        26,
        23,
        202,
        70,
        178,
        227,
        141
      ]
    },
    {
      "name": "pouchCreated",
      "discriminator": [
        68,
        216,
        178,
        83,
        69,
        109,
        53,
        12
      ]
    },
    {
      "name": "rulesSet",
      "discriminator": [
        202,
        104,
        215,
        176,
        23,
        71,
        106,
        72
      ]
    },
    {
      "name": "toppedUp",
      "discriminator": [
        97,
        81,
        238,
        182,
        97,
        234,
        177,
        152
      ]
    },
    {
      "name": "unfrozen",
      "discriminator": [
        222,
        72,
        230,
        135,
        198,
        225,
        71,
        65
      ]
    },
    {
      "name": "withdrawn",
      "discriminator": [
        20,
        89,
        223,
        198,
        194,
        124,
        219,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not authorized"
    },
    {
      "code": 6001,
      "name": "pouchFrozen",
      "msg": "Pouch is frozen"
    },
    {
      "code": 6002,
      "name": "merchantNotAllowed",
      "msg": "Merchant is not on the allowlist"
    },
    {
      "code": 6003,
      "name": "overPerOrderLimit",
      "msg": "Amount exceeds the per-order limit"
    },
    {
      "code": 6004,
      "name": "overDailyLimit",
      "msg": "Amount exceeds the daily limit"
    },
    {
      "code": 6005,
      "name": "insufficientFunds",
      "msg": "Vault balance is too low"
    },
    {
      "code": 6006,
      "name": "nameTooLong",
      "msg": "Pouch name is longer than 32 bytes"
    },
    {
      "code": 6007,
      "name": "tooManyMerchants",
      "msg": "Too many allowed merchants (max 10)"
    },
    {
      "code": 6008,
      "name": "vaultNotEmpty",
      "msg": "Vault must be empty to close the pouch"
    },
    {
      "code": 6009,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6010,
      "name": "zeroLimit",
      "msg": "Per-order and daily limits must be greater than zero"
    },
    {
      "code": 6011,
      "name": "perOrderOverDaily",
      "msg": "Per-order limit exceeds the daily limit"
    },
    {
      "code": 6012,
      "name": "agentIsOwner",
      "msg": "Agent key must differ from the owner"
    },
    {
      "code": 6013,
      "name": "duplicateMerchant",
      "msg": "Allowed merchants contain a duplicate"
    },
    {
      "code": 6014,
      "name": "merchantTokenNotAta",
      "msg": "Merchant token account is not the merchant's associated token account"
    }
  ],
  "types": [
    {
      "name": "frozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "paymentMade",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "orderId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "time",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pouch",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "allowedMerchants",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "maxPerOrder",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "spentToday",
            "type": "u64"
          },
          {
            "name": "dayStart",
            "type": "i64"
          },
          {
            "name": "frozen",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pouchClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          },
          {
            "name": "time",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pouchCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "maxPerOrder",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "time",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "receipt",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "time",
            "type": "i64"
          },
          {
            "name": "orderId",
            "docs": [
              "Client order id; also the receipt PDA seed. Appended last so older fields keep their offsets."
            ],
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
      "name": "rulesSet",
      "docs": [
        "Emitted with the rules in effect after `set_rules` (unchanged fields included)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          },
          {
            "name": "maxPerOrder",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "merchantCount",
            "type": "u8"
          },
          {
            "name": "time",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "toppedUp",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "time",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "unfrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "withdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pouch",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "time",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
