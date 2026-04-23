vim.g.mapleader = ' '
vim.g.maplocalleader = '\\'

vim.keymap.set('n', '<leader>ff', '<cmd>Telescope find_files<cr>', { desc = 'Find files' })
vim.keymap.set('n', '<leader>e', '<cmd>Neotree toggle<cr>', { desc = 'File tree' })
vim.keymap.set('n', '<leader>mp', '<cmd>MarkdownPreview<cr>', { desc = 'MD preview' })
vim.keymap.set('n', '<C-s>', ':w<CR>', { desc = 'Save' })
