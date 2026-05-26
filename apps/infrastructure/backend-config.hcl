# Terraform Backend Configuration for MeatGeek V2
# Update these values to match your Azure storage setup

resource_group_name  = "MeatGeek-Shared"              # Your existing resource group
storage_account_name = "meatgeekterraformstate"       # Your storage account for Terraform state
container_name       = "tfstate"                      # Container for state files
key                 = "meatgeek-v2.terraform.tfstate" # State file name