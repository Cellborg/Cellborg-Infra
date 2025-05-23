name: Terraform Frontend Workflow

on:
  workflow_dispatch:

jobs:
  terraform:
    name: 'Terraform Plan and Apply'
    runs-on: ubuntu-latest

    env:
      TF_VERSION: 1.0.0
      AWS_REGION: us-east-1
      S3_BUCKET: cellborg-tf-state
      S3_KEY: frontend.tfstate

    steps:
      - name: Checkout code
        uses: actions/checkout@v2

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v1
        with:
          terraform_version: ${{ env.TF_VERSION }}

      - name: Terraform Init
        run: terraform init -backend-config="bucket=${{ env.S3_BUCKET }}" -backend-config="key=${{ env.S3_KEY }}" -backend-config="region=${{ env.AWS_REGION }}"
        working-directory: terraform-iac/frontend

      - name: Terraform Plan
        run: terraform plan -out=tfplan
        working-directory: terraform-iac/frontend

      - name: Save Plan
        uses: actions/upload-artifact@v2
        with:
          name: tfplan
          path: terraform-iac/frontend/tfplan

  apply:
    name: 'Terraform Apply'
    runs-on: ubuntu-latest
    needs: terraform

    env:
      TF_VERSION: 1.0.0
      AWS_REGION: us-east-1
      S3_BUCKET: cellborg-tf-state
      S3_KEY: frontend.tfstate

    steps:
      - name: Checkout code
        uses: actions/checkout@v2

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v1
        with:
          terraform_version: ${{ env.TF_VERSION }}

      - name: Download Plan
        uses: actions/download-artifact@v2
        with:
          name: tfplan
          path: terraform-iac/frontend

      - name: Terraform Apply
        run: terraform apply tfplan
        working-directory: terraform-iac/frontend